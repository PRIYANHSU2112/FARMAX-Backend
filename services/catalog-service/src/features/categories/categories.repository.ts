import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  AdminCategoryListQuery,
  Breadcrumb,
  CategoryRow,
  CategorySummary,
} from './categories.types.js';

/** Columns of the tree cache (no audit columns: smaller payload, faster JSON). */
const ROW_SELECT = {
  id: true,
  parentId: true,
  path: true,
  depth: true,
  name: true,
  nameTe: true,
  slug: true,
  description: true,
  imageUrl: true,
  sortOrder: true,
  isActive: true,
  version: true,
} satisfies Prisma.CategorySelect;

const LIVE_CHILDREN = { where: { deletedAt: null } } as const;

const RECORD_SELECT = {
  ...ROW_SELECT,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { children: LIVE_CHILDREN } },
} satisfies Prisma.CategorySelect;

type RecordRow = Prisma.CategoryGetPayload<{ select: typeof RECORD_SELECT }>;

/** A live category with audit columns and its live child count (admin views). */
export type CategoryRecord = Omit<RecordRow, '_count'> & { childCount: number };

const toRecord = ({ _count, ...row }: RecordRow): CategoryRecord => ({
  ...row,
  childCount: _count.children,
});

export interface CategoryCreateData {
  id: string;
  parentId: string | null;
  path: string;
  depth: number;
  name: string;
  nameTe: string | null;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  actorUserId: string;
}

export type CategoryUpdateData = Partial<
  Pick<
    CategoryRow,
    'name' | 'nameTe' | 'slug' | 'description' | 'imageUrl' | 'sortOrder' | 'isActive'
  >
>;

export interface MoveData {
  id: string;
  oldPath: string;
  newPath: string;
  depthDelta: number;
  parentId: string | null;
  sortOrder: number;
  actorUserId: string;
}

type Client = Cradle['db'] | Tx;

/**
 * Only place that queries `categories`. Reads used inside a write transaction take `tx`
 * (the tree advisory lock is held, so read-check-write is race free).
 */
export class CategoriesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Every live row, parents before children (one indexed scan; feeds the tree cache). */
  loadAll(): Promise<CategoryRow[]> {
    return withPrismaErrors(() =>
      this.db.category.findMany({
        where: { deletedAt: null },
        select: ROW_SELECT,
        orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  async findLive(id: string, client: Client = this.db): Promise<CategoryRecord | null> {
    const row = await withPrismaErrors(() =>
      client.category.findFirst({ where: { id, deletedAt: null }, select: RECORD_SELECT }),
    );
    return row === null ? null : toRecord(row);
  }

  async list(query: AdminCategoryListQuery): Promise<Paginated<CategoryRecord>> {
    const q = query.q?.trim();
    const where: Prisma.CategoryWhereInput = {
      deletedAt: null,
      ...(query.parentId === undefined
        ? {}
        : { parentId: query.parentId === 'root' ? null : query.parentId }),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(q === undefined || q === ''
        ? {}
        : {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { nameTe: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q.toLowerCase() } },
            ],
          }),
    };
    const rows = await withPrismaErrors(() =>
      this.db.category.findMany({
        where,
        select: RECORD_SELECT,
        // Tree order: level, then sibling order. `id` makes the keyset cursor stable.
        orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        ...cursorArgs(query),
      }),
    );
    return toPage(rows.map(toRecord), query.limit);
  }

  /** Ancestors in root → parent order (ids come from the path). */
  async breadcrumbs(ids: readonly string[]): Promise<Breadcrumb[]> {
    if (ids.length === 0) return [];
    const rows = await withPrismaErrors(() =>
      this.db.category.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, name: true, nameTe: true, slug: true },
      }),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)).filter((row): row is Breadcrumb => row !== undefined);
  }

  async liveChildren(parentId: string): Promise<(CategorySummary & { isActive: boolean })[]> {
    const rows = await withPrismaErrors(() =>
      this.db.category.findMany({
        where: { parentId, deletedAt: null },
        select: {
          id: true,
          parentId: true,
          name: true,
          nameTe: true,
          slug: true,
          imageUrl: true,
          depth: true,
          sortOrder: true,
          isActive: true,
          _count: { select: { children: LIVE_CHILDREN } },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
    return rows.map(({ _count, ...row }) => ({ ...row, childCount: _count.children }));
  }

  /** Which unique keys (slug, sibling name) are already used by another live category. */
  async conflicts(
    tx: Tx,
    check: { slug?: string; name?: string; parentId: string | null; excludeId?: string },
  ): Promise<{ slug: boolean; name: boolean }> {
    const or: Prisma.CategoryWhereInput[] = [];
    if (check.slug !== undefined) or.push({ slug: check.slug });
    if (check.name !== undefined)
      or.push({ parentId: check.parentId, name: { equals: check.name, mode: 'insensitive' } });
    if (or.length === 0) return { slug: false, name: false };
    const rows = await tx.category.findMany({
      where: {
        deletedAt: null,
        ...(check.excludeId === undefined ? {} : { id: { not: check.excludeId } }),
        OR: or,
      },
      select: { slug: true, name: true, parentId: true },
      take: 2,
    });
    return {
      slug: check.slug !== undefined && rows.some((row) => row.slug === check.slug),
      name:
        check.name !== undefined &&
        rows.some(
          (row) =>
            row.parentId === check.parentId && row.name.toLowerCase() === check.name?.toLowerCase(),
        ),
    };
  }

  async slugsStartingWith(tx: Tx, base: string): Promise<Set<string>> {
    const rows = await tx.category.findMany({
      where: { deletedAt: null, slug: { startsWith: base } },
      select: { slug: true },
    });
    return new Set(rows.map((row) => row.slug));
  }

  /** Next sibling sortOrder (max + 10) so a new category lands last. */
  async nextSortOrder(tx: Tx, parentId: string | null): Promise<number> {
    const agg = await tx.category.aggregate({
      where: { parentId, deletedAt: null },
      _max: { sortOrder: true },
    });
    return (agg._max.sortOrder ?? 0) + 10;
  }

  async create(tx: Tx, data: CategoryCreateData): Promise<CategoryRecord> {
    const { actorUserId, ...fields } = data;
    const row = await tx.category.create({
      data: { ...fields, createdByUserId: actorUserId, updatedByUserId: actorUserId },
      select: RECORD_SELECT,
    });
    return toRecord(row);
  }

  async update(
    tx: Tx,
    id: string,
    data: CategoryUpdateData,
    actorUserId: string,
  ): Promise<CategoryRecord> {
    const row = await tx.category.update({
      where: { id },
      data: { ...data, updatedByUserId: actorUserId, version: { increment: 1 } },
      select: RECORD_SELECT,
    });
    return toRecord(row);
  }

  /** Deepest live depth in the subtree rooted at `path` (index range scan on path). */
  async subtreeMaxDepth(tx: Tx, path: string): Promise<number> {
    const [row] = await tx.$queryRaw<{ maxDepth: number | null }[]>`
      SELECT max("depth")::int AS "maxDepth" FROM "categories"
      WHERE "path" LIKE ${`${path}%`} AND "deletedAt" IS NULL`;
    return row?.maxDepth ?? 0;
  }

  /**
   * Moves a whole subtree in ONE statement: every descendant's path prefix and depth are
   * rewritten, and the moved node also gets its new parent and sort order. Returns rows changed.
   */
  moveSubtree(tx: Tx, move: MoveData): Promise<number> {
    return tx.$executeRaw`
      UPDATE "categories" SET
        "path" = ${move.newPath} || substr("path", ${move.oldPath.length + 1}::int),
        "depth" = "depth" + ${move.depthDelta}::int,
        "parentId" = CASE WHEN "id" = ${move.id}::uuid THEN ${move.parentId}::uuid ELSE "parentId" END,
        "sortOrder" = CASE WHEN "id" = ${move.id}::uuid THEN ${move.sortOrder}::int ELSE "sortOrder" END,
        "updatedByUserId" = CASE WHEN "id" = ${move.id}::uuid THEN ${move.actorUserId}::uuid ELSE "updatedByUserId" END,
        "version" = "version" + 1,
        "updatedAt" = now()
      WHERE "path" LIKE ${`${move.oldPath}%`} AND "deletedAt" IS NULL`;
  }

  async liveChildIds(tx: Tx, parentId: string | null): Promise<string[]> {
    const rows = await tx.category.findMany({
      where: { parentId, deletedAt: null },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** Sets sortOrder = 10, 20, 30 … in the given order (one statement). */
  reorder(tx: Tx, orderedIds: readonly string[], actorUserId: string): Promise<number> {
    const orders = orderedIds.map((_, i) => (i + 1) * 10);
    return tx.$executeRaw`
      UPDATE "categories" AS c SET
        "sortOrder" = v.ord,
        "version" = c."version" + 1,
        "updatedByUserId" = ${actorUserId}::uuid,
        "updatedAt" = now()
      FROM unnest(${[...orderedIds]}::uuid[], ${orders}::int[]) AS v(id, ord)
      WHERE c."id" = v.id AND c."deletedAt" IS NULL`;
  }

  async softDelete(tx: Tx, id: string, actorUserId: string): Promise<void> {
    await tx.category.update({
      where: { id },
      data: { deletedAt: new Date(), updatedByUserId: actorUserId, version: { increment: 1 } },
    });
  }
}
