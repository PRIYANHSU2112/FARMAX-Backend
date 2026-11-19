import { createHash } from 'node:crypto';

import { ConflictError, NotFoundError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { type Tx, isUniqueViolation, mapPrismaError } from '@farmx/database';
import { catalogKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { LocalCache } from '../../adapters/local-cache.js';
import { emitCatalogEvent } from '../../adapters/events.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { Actor, AuditRecord } from '../audit/index.js';
import type {
  AdminBrandListQuery,
  BrandListQuery,
  BrandRecord,
  BrandRow,
  BrandSnapshot,
  BrandUpdateData,
  CreateBrandInput,
  PublicBrand,
  SetBrandStatusInput,
  UpdateBrandInput,
} from './brands.types.js';

type Deps = Pick<
  Cradle,
  'brandsRepository' | 'cache' | 'runInTransaction' | 'auditService' | 'productClient'
>;

/** Brand fields product-service mirrors (brand name snapshot, search text, visibility). */
const SYNCED_FIELDS = ['name', 'code', 'slug', 'isActive'] as const;

/** Public reads carry the snapshot ETag so the controller can answer 304. */
export interface Tagged<T> {
  etag: string;
  data: T;
}

const SNAPSHOT_TTL_SECONDS = 600;
const LOCAL_TTL_MS = 30_000;
const SNAPSHOT = 'brands';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Pure helpers (exported for unit tests) ──

export const etagOf = (rows: readonly BrandRow[]): string => {
  const hash = createHash('sha1');
  for (const row of rows) hash.update(`${row.id}:${String(row.version)};`);
  return `W/"${hash.digest('base64url').slice(0, 22)}"`;
};

/** URL slug from a name: ASCII lower-case words joined by `-`. */
export const slugify = (text: string): string => {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/, '');
  return slug === '' ? 'brand' : slug;
};

export const firstFreeSlug = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
};

export const toPublic = (row: BrandRow): PublicBrand => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  code: row.code,
  description: row.description,
  logoUrl: row.logoUrl,
  bannerUrl: row.bannerUrl,
  websiteUrl: row.websiteUrl,
  countryOfOrigin: row.countryOfOrigin,
  isFeatured: row.isFeatured,
  sortOrder: row.sortOrder,
});

/** In-memory search/filter/keyset page over the snapshot (brands are few: hundreds). */
export const filterBrands = (
  rows: readonly BrandRow[],
  query: BrandListQuery,
): Paginated<BrandRow> => {
  const q = query.q?.trim().toLowerCase();
  let items = rows.filter(
    (row) =>
      (query.isFeatured === undefined || row.isFeatured === query.isFeatured) &&
      (q === undefined ||
        q === '' ||
        row.name.toLowerCase().includes(q) ||
        row.code.toLowerCase().includes(q) ||
        row.slug.includes(q)),
  );
  if (query.cursor !== undefined) {
    const at = items.findIndex((row) => row.id === query.cursor);
    items = at === -1 ? [] : items.slice(at + 1);
  }
  const page = items.slice(0, query.limit);
  const hasMore = items.length > query.limit;
  return {
    items: page,
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    limit: query.limit,
  };
};

const versionConflict = (current: number) =>
  new ConflictError('The brand was changed by someone else; reload and retry', {
    details: { reason: 'BRAND_VERSION_CONFLICT', currentVersion: current },
  });

const taken = (fields: string[]) =>
  new ConflictError(`A brand with this ${fields.join(', ')} already exists`, {
    details: { reason: 'BRAND_DUPLICATE', fields },
  });

/**
 * Brands. Public reads: one snapshot of every active brand (in-process 30 s → Redis 10 min
 * single-flight → one indexed query), filtered in memory. Writes: one transaction under a brand
 * advisory lock, audit row in the same transaction, caches dropped after commit.
 */
export class BrandsService {
  private readonly local = new LocalCache<BrandSnapshot>(1, LOCAL_TTL_MS);

  constructor(private readonly deps: Deps) {}

  private async snapshot(): Promise<BrandSnapshot> {
    let snap = this.local.get(SNAPSHOT);
    if (snap === undefined) {
      snap = await this.deps.cache.getOrSet(
        catalogKeys.brands(),
        SNAPSHOT_TTL_SECONDS,
        async () => {
          const rows = await this.deps.brandsRepository.loadActive();
          return { rows, etag: etagOf(rows) };
        },
      );
      this.local.set(SNAPSHOT, snap);
    }
    return snap;
  }

  private async invalidate(): Promise<void> {
    this.local.delete(SNAPSHOT);
    await this.deps.cache.invalidate(catalogKeys.brands()).catch(() => undefined);
  }

  // ── Storefront ──

  async publicList(query: BrandListQuery): Promise<Tagged<Paginated<PublicBrand>>> {
    const { rows, etag } = await this.snapshot();
    const page = filterBrands(rows, query);
    return { etag, data: { ...page, items: page.items.map(toPublic) } };
  }

  async publicDetail(slugOrId: string): Promise<Tagged<PublicBrand>> {
    const { rows, etag } = await this.snapshot();
    const key = UUID.test(slugOrId) ? 'id' : 'slug';
    const row = rows.find((r) => r[key] === slugOrId);
    if (row === undefined) throw new NotFoundError('Brand');
    return { etag, data: toPublic(row) };
  }

  // ── Admin reads ──

  list(query: AdminBrandListQuery): Promise<Paginated<BrandRecord>> {
    return this.deps.brandsRepository.list(query);
  }

  async detail(id: string): Promise<BrandRecord> {
    const record = await this.deps.brandsRepository.findLive(id);
    if (record === null) throw new NotFoundError('Brand');
    return record;
  }

  history(id: string, query: { cursor?: string; limit: number }): Promise<Paginated<AuditRecord>> {
    return this.deps.auditService.history('brand', id, query);
  }

  // ── Admin writes ──

  async create(input: CreateBrandInput, actor: Actor): Promise<BrandRecord> {
    const { reason, ...fields } = input;
    const record = await this.write(async (tx) => {
      const slug =
        fields.slug ??
        firstFreeSlug(
          slugify(fields.name),
          await this.deps.brandsRepository.slugsStartingWith(tx, slugify(fields.name)),
        );
      await this.assertUnique(tx, { name: fields.name, slug, code: fields.code });
      const id = uuidv7();
      const created = await this.deps.brandsRepository.create(tx, {
        id,
        name: fields.name,
        slug,
        code: fields.code,
        description: fields.description === '' ? null : (fields.description ?? null),
        logoUrl: fields.logoUrl ?? null,
        bannerUrl: fields.bannerUrl ?? null,
        websiteUrl: fields.websiteUrl ?? null,
        countryOfOrigin: fields.countryOfOrigin ?? null,
        isFeatured: fields.isFeatured ?? false,
        isActive: fields.isActive ?? true,
        sortOrder: fields.sortOrder ?? 0,
        actorUserId: actor.userId,
      });
      await this.deps.auditService.record(tx, actor, {
        action: 'brand.create',
        targetType: 'brand',
        targetId: id,
        after: created,
        reason,
      });
      return created;
    });
    await this.invalidate();
    return record;
  }

  update(
    id: string,
    input: UpdateBrandInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<BrandRecord> {
    const { reason, ...changes } = input;
    return this.change(id, changes, reason, ifMatch, actor, 'brand.update');
  }

  setStatus(
    id: string,
    input: SetBrandStatusInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<BrandRecord> {
    const { reason, ...changes } = input;
    return this.change(id, changes, reason, ifMatch, actor, 'brand.status');
  }

  async remove(
    id: string,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<void> {
    // Safe delete (plan §E): product-service blocks new assignments iff no product uses it.
    await this.deps.productClient.block('BRAND', id);
    try {
      await this.write(async (tx) => {
        const current = await this.liveOrThrow(tx, id, ifMatch);
        await this.deps.brandsRepository.softDelete(tx, id, actor.userId);
        await this.deps.auditService.record(tx, actor, {
          action: 'brand.delete',
          targetType: 'brand',
          targetId: id,
          before: current,
          reason,
        });
        await emitCatalogEvent(tx, 'catalog.brand_deleted.v1', { brandId: id }, actor.requestId);
      });
    } catch (error) {
      await this.deps.productClient.unblock('BRAND', id);
      throw error;
    }
    await this.invalidate();
  }

  /** Internal (product-service writes): authoritative brand state from the database. */
  async internalBrand(id: string) {
    const row = await this.deps.brandsRepository.findLive(id);
    if (row === null) throw new NotFoundError('Brand');
    const { name, slug, code, logoUrl, isActive } = row;
    return { id, name, slug, code, logoUrl, isActive };
  }

  // ── Helpers ──

  private async change(
    id: string,
    changes: BrandUpdateData,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
    action: 'brand.update' | 'brand.status',
  ): Promise<BrandRecord> {
    const record = await this.write(async (tx) => {
      const current = await this.liveOrThrow(tx, id, ifMatch);
      const data: BrandUpdateData = {};
      for (const [key, value] of Object.entries(changes) as [keyof BrandUpdateData, unknown][]) {
        const next = key === 'description' && value === '' ? null : value;
        if (next !== undefined && next !== current[key]) Object.assign(data, { [key]: next });
      }
      if (Object.keys(data).length === 0) return current;
      await this.assertUnique(tx, {
        ...(data.name === undefined ? {} : { name: data.name }),
        ...(data.slug === undefined ? {} : { slug: data.slug }),
        ...(data.code === undefined ? {} : { code: data.code }),
        excludeId: id,
      });
      const updated = await this.deps.brandsRepository.update(tx, id, data, actor.userId);
      const before = Object.fromEntries(
        Object.keys(data).map((key) => [key, current[key as keyof BrandUpdateData]]),
      );
      await this.deps.auditService.record(tx, actor, {
        action,
        targetType: 'brand',
        targetId: id,
        before,
        after: data,
        reason,
      });
      if (SYNCED_FIELDS.some((key) => key in data)) {
        const { name, code, slug, isActive, version } = updated;
        await emitCatalogEvent(
          tx,
          'catalog.brand_updated.v1',
          { brandId: id, name, code, slug, isActive, version },
          actor.requestId,
        );
      }
      return updated;
    });
    await this.invalidate();
    return record;
  }

  /** One transaction, brand lock first; unique-index races still map to a clean 409. */
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.deps.runInTransaction(async (tx) => {
        await this.deps.brandsRepository.lock(tx);
        return work(tx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw taken(['name', 'slug', 'code']);
      const mapped = mapPrismaError(error);
      throw mapped instanceof Error ? mapped : error;
    }
  }

  private async liveOrThrow(tx: Tx, id: string, ifMatch: number | undefined): Promise<BrandRecord> {
    const row = await this.deps.brandsRepository.findLive(id, tx);
    if (row === null) throw new NotFoundError('Brand');
    if (ifMatch !== undefined && ifMatch !== row.version) throw versionConflict(row.version);
    return row;
  }

  private async assertUnique(
    tx: Tx,
    check: { name?: string; slug?: string; code?: string; excludeId?: string },
  ): Promise<void> {
    const fields = await this.deps.brandsRepository.conflicts(tx, check);
    if (fields.length > 0) throw taken(fields);
  }
}
