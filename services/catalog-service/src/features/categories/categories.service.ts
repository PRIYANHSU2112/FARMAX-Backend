import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { type Tx, advisoryXactLock, isUniqueViolation, mapPrismaError } from '@farmx/database';
import { catalogKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { emitCatalogEvent } from '../../adapters/events.js';
import { LocalCache } from '../../adapters/local-cache.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { Actor, AuditRecord } from '../audit/index.js';
import type { CategoryRecord, CategoryUpdateData } from './categories.repository.js';
import type {
  AdminCategory,
  AdminCategoryDetail,
  AdminCategoryListQuery,
  AdminTreeNode,
  CategoryNode,
  CategoryRow,
  CategorySummary,
  CreateCategoryInput,
  MoveCategoryInput,
  PublicCategoryDetail,
  ReorderCategoriesInput,
  TreeSnapshot,
  UpdateCategoryInput,
} from './categories.types.js';
import {
  CategoryIndex,
  checkMove,
  childPath,
  etagOf,
  firstFreeSlug,
  pathIds,
  slugify,
  toBreadcrumb,
  toSummary,
} from './category.tree.js';

type Deps = Pick<
  Cradle,
  | 'categoriesRepository'
  | 'cache'
  | 'runInTransaction'
  | 'auditService'
  | 'config'
  | 'productClient'
>;

/** Public reads carry the snapshot ETag so the controller can answer 304. */
export interface Tagged<T> {
  etag: string;
  data: T;
}

const TREE_LOCK = 'catalog:category-tree';
const TREE_TTL_SECONDS = 600;
const LOCAL_TTL_MS = 30_000;
const SNAPSHOT = 'tree';

const versionConflict = (current: number) =>
  new ConflictError('The category was changed by someone else; reload and retry', {
    details: { reason: 'CATEGORY_VERSION_CONFLICT', currentVersion: current },
  });

/**
 * Category tree: adjacency list + materialized path (D-28).
 *
 * Reads: the whole live tree is ONE cached snapshot (in-process 30 s → Redis 10 min single-flight
 * → one indexed query) turned into a `CategoryIndex`, so storefront reads never touch Postgres.
 * Writes: one transaction under a tree-wide advisory lock (admin writes are rare; it makes
 * read-check-write and subtree moves race free), audit row in the same transaction, caches
 * dropped after commit.
 */
export class CategoriesService {
  private readonly local = new LocalCache<TreeSnapshot>(1, LOCAL_TTL_MS);
  private built: { etag: string; index: CategoryIndex } | undefined;

  constructor(private readonly deps: Deps) {}

  // ── Snapshot ──

  private async snapshot(): Promise<{ etag: string; index: CategoryIndex }> {
    let snap = this.local.get(SNAPSHOT);
    if (snap === undefined) {
      snap = await this.deps.cache.getOrSet(
        catalogKeys.categoryTree(),
        TREE_TTL_SECONDS,
        async () => {
          const rows = await this.deps.categoriesRepository.loadAll();
          return { rows, etag: etagOf(rows) };
        },
      );
      this.local.set(SNAPSHOT, snap);
    }
    // Build the maps once per snapshot, not per request.
    if (this.built?.etag !== snap.etag)
      this.built = { etag: snap.etag, index: new CategoryIndex(snap.rows) };
    return this.built;
  }

  private async invalidate(): Promise<void> {
    this.local.delete(SNAPSHOT);
    this.built = undefined;
    await this.deps.cache.invalidate(catalogKeys.categoryTree()).catch(() => undefined);
  }

  private get maxLevels(): number {
    return this.deps.config.CATALOG_MAX_CATEGORY_DEPTH;
  }

  // ── Storefront ──

  async publicTree(maxDepth: number | undefined): Promise<Tagged<CategoryNode[]>> {
    const { etag, index } = await this.snapshot();
    const levels = maxDepth ?? this.maxLevels;
    return {
      etag,
      data: index.tree<CategoryNode>(null, levels, true, (row, children, childCount) => ({
        ...toSummary(row, childCount),
        children,
      })),
    };
  }

  async publicDetail(slug: string): Promise<Tagged<PublicCategoryDetail>> {
    const { etag, index } = await this.snapshot();
    const row = this.visibleBySlug(index, slug);
    const children = index.children(row.id, true);
    return {
      etag,
      data: {
        category: { ...toSummary(row, children.length), description: row.description },
        breadcrumbs: index.ancestors(row).map(toBreadcrumb),
        children: children.map((child) => toSummary(child, index.children(child.id, true).length)),
      },
    };
  }

  async publicSubcategories(
    slug: string,
    maxDepth: number | undefined,
  ): Promise<Tagged<CategoryNode[]>> {
    const { etag, index } = await this.snapshot();
    const row = this.visibleBySlug(index, slug);
    return {
      etag,
      data: index.tree<CategoryNode>(
        row.id,
        maxDepth ?? 1,
        true,
        (child, children, childCount) => ({
          ...toSummary(child, childCount),
          children,
        }),
      ),
    };
  }

  /** Unknown and hidden (inactive self or ancestor) look the same: 404. */
  private visibleBySlug(index: CategoryIndex, slug: string): CategoryRow {
    const row = index.bySlug.get(slug);
    if (row === undefined || !index.isVisible(row.id)) throw new NotFoundError('Category');
    return row;
  }

  // ── Admin reads ──

  async list(query: AdminCategoryListQuery): Promise<Paginated<AdminCategory>> {
    const [page, { index }] = await Promise.all([
      this.deps.categoriesRepository.list(query),
      this.snapshot(),
    ]);
    return { ...page, items: page.items.map((record) => this.toAdmin(record, index)) };
  }

  async adminTree(): Promise<Tagged<AdminTreeNode[]>> {
    const { etag, index } = await this.snapshot();
    return {
      etag,
      data: index.tree<AdminTreeNode>(null, this.maxLevels, false, (row, children, childCount) => ({
        ...toSummary(row, childCount),
        isActive: row.isActive,
        effectiveActive: index.isVisible(row.id),
        children,
      })),
    };
  }

  async detail(id: string): Promise<AdminCategoryDetail> {
    const record = await this.deps.categoriesRepository.findLive(id);
    if (record === null) throw new NotFoundError('Category');
    const [ancestors, children, { index }] = await Promise.all([
      this.deps.categoriesRepository.breadcrumbs(pathIds(record.path).slice(0, -1)),
      this.deps.categoriesRepository.liveChildren(id),
      this.snapshot(),
    ]);
    return { ...this.toAdmin(record, index), ancestors, children };
  }

  async history(
    id: string,
    query: { cursor?: string; limit: number },
  ): Promise<Paginated<AuditRecord>> {
    // History outlives a soft delete, so it is not gated on the category being live.
    return this.deps.auditService.history('category', id, query);
  }

  /** effectiveActive from the cached index; a row newer than the snapshot falls back to isActive. */
  private toAdmin(record: CategoryRecord, index: CategoryIndex): AdminCategory {
    const known = index.byId.has(record.id);
    const parentVisible =
      record.parentId === null ||
      index.isVisible(record.parentId) ||
      !index.byId.has(record.parentId);
    return {
      ...record,
      effectiveActive: known ? index.isVisible(record.id) : record.isActive && parentVisible,
    };
  }

  // ── Admin writes ──

  async create(input: CreateCategoryInput, actor: Actor): Promise<AdminCategory> {
    const { reason, parentId = null, ...fields } = input;
    const record = await this.write(async (tx) => {
      const parent = parentId === null ? null : await this.liveParent(tx, parentId);
      const depth = parent === null ? 0 : parent.depth + 1;
      if (depth >= this.maxLevels) {
        throw new ValidationError([
          {
            path: 'parentId',
            message: `Categories can be at most ${String(this.maxLevels)} levels deep`,
          },
        ]);
      }
      const slug =
        fields.slug ??
        firstFreeSlug(
          slugify(fields.name),
          await this.deps.categoriesRepository.slugsStartingWith(tx, slugify(fields.name)),
        );
      await this.assertUnique(tx, { slug, name: fields.name, parentId });
      const id = uuidv7();
      const created = await this.deps.categoriesRepository.create(tx, {
        id,
        parentId,
        path: childPath(parent?.path ?? null, id),
        depth,
        name: fields.name,
        nameTe: fields.nameTe ?? null,
        slug,
        description: fields.description ?? null,
        imageUrl: fields.imageUrl ?? null,
        sortOrder:
          fields.sortOrder ?? (await this.deps.categoriesRepository.nextSortOrder(tx, parentId)),
        isActive: fields.isActive ?? true,
        actorUserId: actor.userId,
      });
      await this.deps.auditService.record(tx, actor, {
        action: 'category.create',
        targetType: 'category',
        targetId: id,
        after: created,
        reason,
      });
      return created;
    });
    return this.afterWrite(record);
  }

  async update(
    id: string,
    input: UpdateCategoryInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<AdminCategory> {
    const { reason, ...changes } = input;
    const record = await this.write(async (tx) => {
      const current = await this.liveOrThrow(tx, id, ifMatch);
      const data: CategoryUpdateData = {};
      for (const [key, value] of Object.entries(changes) as [keyof CategoryUpdateData, unknown][]) {
        if (value !== undefined && value !== current[key]) Object.assign(data, { [key]: value });
      }
      if (Object.keys(data).length === 0) return current;
      await this.assertUnique(tx, {
        ...(data.slug === undefined ? {} : { slug: data.slug }),
        ...(data.name === undefined ? {} : { name: data.name }),
        parentId: current.parentId,
        excludeId: id,
      });
      const updated = await this.deps.categoriesRepository.update(tx, id, data, actor.userId);
      const before = Object.fromEntries(
        Object.keys(data).map((key) => [key, current[key as keyof CategoryUpdateData]]),
      );
      await this.deps.auditService.record(tx, actor, {
        action: 'category.update',
        targetType: 'category',
        targetId: id,
        before,
        after: data,
        reason,
      });
      return updated;
    });
    return this.afterWrite(record);
  }

  async move(
    id: string,
    input: MoveCategoryInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<AdminCategory> {
    const record = await this.write(async (tx) => {
      const node = await this.liveOrThrow(tx, id, ifMatch);
      const parent = input.parentId === null ? null : await this.liveParent(tx, input.parentId);
      const subtreeMaxDepth = await this.deps.categoriesRepository.subtreeMaxDepth(tx, node.path);
      const problem = checkMove(node, parent, subtreeMaxDepth, this.maxLevels);
      if (problem === 'CYCLE') {
        throw new ValidationError([
          {
            path: 'parentId',
            message: 'A category cannot be moved under itself or one of its sub-categories',
          },
        ]);
      }
      if (problem === 'DEPTH') {
        throw new ValidationError([
          {
            path: 'parentId',
            message: `The moved branch would exceed ${String(this.maxLevels)} levels`,
          },
        ]);
      }
      if (node.parentId !== input.parentId) {
        await this.assertUnique(tx, { name: node.name, parentId: input.parentId, excludeId: id });
      }
      const newPath = childPath(parent?.path ?? null, id);
      const sortOrder =
        input.sortOrder ??
        (node.parentId === input.parentId
          ? node.sortOrder
          : await this.deps.categoriesRepository.nextSortOrder(tx, input.parentId));
      const moved = await this.deps.categoriesRepository.moveSubtree(tx, {
        id,
        oldPath: node.path,
        newPath,
        depthDelta: (parent === null ? 0 : parent.depth + 1) - node.depth,
        parentId: input.parentId,
        sortOrder,
        actorUserId: actor.userId,
      });
      await this.deps.auditService.record(tx, actor, {
        action: 'category.move',
        targetType: 'category',
        targetId: id,
        before: { parentId: node.parentId, path: node.path, depth: node.depth },
        after: { parentId: input.parentId, path: newPath, sortOrder, movedDescendants: moved - 1 },
        reason: input.reason,
      });
      const after = await this.deps.categoriesRepository.findLive(id, tx);
      if (after === null) throw new NotFoundError('Category');
      return after;
    });
    return this.afterWrite(record);
  }

  async reorder(input: ReorderCategoriesInput, actor: Actor): Promise<CategorySummary[]> {
    await this.write(async (tx) => {
      if (input.parentId !== null) await this.liveParent(tx, input.parentId);
      const live = await this.deps.categoriesRepository.liveChildIds(tx, input.parentId);
      const wanted = new Set(input.orderedIds);
      if (live.length !== wanted.size || live.some((childId) => !wanted.has(childId))) {
        throw new ValidationError([
          {
            path: 'orderedIds',
            message: `must list every live sub-category of the parent exactly once (${String(live.length)} expected)`,
          },
        ]);
      }
      await this.deps.categoriesRepository.reorder(tx, input.orderedIds, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'category.reorder',
        targetType: 'category',
        targetId: input.parentId ?? 'root',
        after: { orderedIds: input.orderedIds },
        reason: input.reason,
      });
    });
    await this.invalidate();
    const { index } = await this.snapshot();
    return index
      .children(input.parentId, false)
      .map((row) => toSummary(row, index.children(row.id, false).length));
  }

  async remove(
    id: string,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<void> {
    // Safe delete (plan §E): product-service blocks new assignments iff no product uses it.
    await this.deps.productClient.block('CATEGORY', id);
    try {
      await this.removeBlocked(id, reason, ifMatch, actor);
    } catch (error) {
      await this.deps.productClient.unblock('CATEGORY', id);
      throw error;
    }
    await this.invalidate();
  }

  private async removeBlocked(
    id: string,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<void> {
    await this.write(async (tx) => {
      const current = await this.liveOrThrow(tx, id, ifMatch);
      if (current.childCount > 0) {
        throw new ConflictError('Move or delete its sub-categories first', {
          details: { reason: 'CATEGORY_HAS_CHILDREN', childCount: current.childCount },
        });
      }
      await this.deps.categoriesRepository.softDelete(tx, id, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'category.delete',
        targetType: 'category',
        targetId: id,
        before: current,
        reason,
      });
      await emitCatalogEvent(
        tx,
        'catalog.category_deleted.v1',
        { categoryId: id },
        actor.requestId,
      );
    });
  }

  /**
   * Internal (product-service writes): authoritative context straight from the database, not the
   * cache — path, breadcrumb, effective activity and the live subtree.
   */
  async internalContext(id: string): Promise<{
    id: string;
    pathIds: string[];
    breadcrumb: { id: string; name: string; slug: string }[];
    effectiveActive: boolean;
    subtreeIds: string[];
  }> {
    const rows = await this.deps.categoriesRepository.loadAll();
    const index = new CategoryIndex(rows);
    const self = index.byId.get(id);
    if (self === undefined) throw new NotFoundError('Category');
    const ids = pathIds(self.path);
    return {
      id,
      pathIds: ids,
      breadcrumb: ids.flatMap((pid) => {
        const row = index.byId.get(pid);
        return row === undefined ? [] : [{ id: row.id, name: row.name, slug: row.slug }];
      }),
      effectiveActive: index.isVisible(id),
      subtreeIds: rows.filter((row) => row.path.startsWith(self.path)).map((row) => row.id),
    };
  }

  // ── Helpers ──

  /** One transaction, tree lock first; unique-index races still map to a clean 409. */
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.deps.runInTransaction(async (tx) => {
        await advisoryXactLock(tx, TREE_LOCK);
        return work(tx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      const mapped = mapPrismaError(error);
      throw mapped instanceof Error ? mapped : error;
    }
  }

  private async afterWrite(record: CategoryRecord): Promise<AdminCategory> {
    await this.invalidate();
    const { index } = await this.snapshot();
    return this.toAdmin(record, index);
  }

  private async liveOrThrow(
    tx: Tx,
    id: string,
    ifMatch: number | undefined,
  ): Promise<CategoryRecord> {
    const row = await this.deps.categoriesRepository.findLive(id, tx);
    if (row === null) throw new NotFoundError('Category');
    if (ifMatch !== undefined && ifMatch !== row.version) throw versionConflict(row.version);
    return row;
  }

  private async liveParent(tx: Tx, parentId: string): Promise<CategoryRecord> {
    const parent = await this.deps.categoriesRepository.findLive(parentId, tx);
    if (parent === null) {
      throw new ValidationError([{ path: 'parentId', message: 'Parent category not found' }]);
    }
    return parent;
  }

  private async assertUnique(
    tx: Tx,
    check: { slug?: string; name?: string; parentId: string | null; excludeId?: string },
  ): Promise<void> {
    const taken = await this.deps.categoriesRepository.conflicts(tx, check);
    if (taken.slug) {
      throw new ConflictError('A category with this slug already exists', {
        details: { reason: 'CATEGORY_SLUG_TAKEN', fields: ['slug'] },
      });
    }
    if (taken.name) {
      throw new ConflictError('A sibling category with this name already exists', {
        details: { reason: 'CATEGORY_NAME_TAKEN', fields: ['name'] },
      });
    }
  }
}

const duplicate = () =>
  new ConflictError('A category with this slug or sibling name already exists', {
    details: { reason: 'CATEGORY_DUPLICATE' },
  });
