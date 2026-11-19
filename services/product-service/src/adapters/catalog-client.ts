import { ServiceUnavailableError, ValidationError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';
import { type Redis, catalogKeys } from '@farmx/infra/redis';

import type { ProductConfig } from '../config/index.js';
import { LocalCache } from './local-cache.js';

/** Shape of catalog-service's cached category snapshot rows (catalogKeys.categoryTree()). */
interface CategoryRow {
  id: string;
  parentId: string | null;
  path: string;
  name: string;
  slug: string;
  isActive: boolean;
}
/** Shape of catalog-service's cached brand snapshot rows (catalogKeys.brands(): active only). */
interface BrandRow {
  id: string;
  name: string;
  slug: string;
  code: string;
  logoUrl: string | null;
}

export interface Crumb {
  id: string;
  name: string;
  slug: string;
}

export interface CategoryContext {
  id: string;
  /** Ids root → self. */
  pathIds: string[];
  breadcrumb: Crumb[];
  /** Self and every ancestor active. */
  effectiveActive: boolean;
  /** Self + all live descendants (for "category including subcategories"). */
  subtreeIds: string[];
}

export interface BrandRef {
  id: string;
  name: string;
  slug: string;
  code: string;
  logoUrl: string | null;
  isActive: boolean;
}

const pathIdsOf = (path: string) => path.split('/').filter((id) => id !== '');
const LOCAL_TTL_MS = 15_000;

/** Pure: context of one category from the snapshot rows (exported for tests). */
export const contextFromRows = (
  rows: readonly CategoryRow[],
  id: string,
): CategoryContext | null => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const self = byId.get(id);
  if (self === undefined) return null;
  const pathIds = pathIdsOf(self.path);
  const chain = pathIds
    .map((pid) => byId.get(pid))
    .filter((r): r is CategoryRow => r !== undefined);
  return {
    id,
    pathIds,
    breadcrumb: chain.map(({ id: cid, name, slug }) => ({ id: cid, name, slug })),
    effectiveActive: chain.length === pathIds.length && chain.every((row) => row.isActive),
    subtreeIds: rows.filter((row) => row.path.startsWith(self.path)).map((row) => row.id),
  };
};

/**
 * catalog-service adapter. Storefront reads use catalog's Redis snapshots (no HTTP, shared
 * redis-cache, D-23 pattern) with an in-process 15 s layer; writes use `fresh: true`, which always
 * asks catalog's internal API (authoritative DB read). Deletion races are closed by product-service's
 * own reference blocks (plan §E), not by catalog state.
 */
export class CatalogClient {
  private readonly categories = new LocalCache<CategoryRow[]>(1, LOCAL_TTL_MS);
  private readonly brands = new LocalCache<BrandRow[]>(1, LOCAL_TTL_MS);

  constructor(
    private readonly deps: { config: ProductConfig; logger: Logger; redis: () => Redis },
  ) {}

  private async snapshot<T>(key: string, local: LocalCache<T[]>): Promise<T[] | undefined> {
    const hit = local.get('rows');
    if (hit !== undefined) return hit;
    try {
      const raw = await this.deps.redis().get(key);
      if (raw === null) return undefined;
      const rows = (JSON.parse(raw) as { rows: T[] }).rows;
      local.set('rows', rows);
      return rows;
    } catch (err) {
      this.deps.logger.warn({ err, key }, 'catalog snapshot unavailable');
      return undefined;
    }
  }

  private async internal<T>(path: string): Promise<T | null> {
    const { config } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined)
      throw new ServiceUnavailableError('catalog-service internal API is not configured');
    let res: Response;
    try {
      res = await fetch(`${config.CATALOG_SERVICE_URL}${path}`, {
        headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
        signal: AbortSignal.timeout(3_000),
      });
    } catch (err) {
      this.deps.logger.error({ err, path }, 'catalog-service unreachable');
      throw new ServiceUnavailableError('Catalog service unavailable');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new ServiceUnavailableError('Catalog service error');
    return ((await res.json()) as { data: T }).data;
  }

  async categoryContext(id: string, { fresh = false } = {}): Promise<CategoryContext | null> {
    if (!fresh) {
      const rows = await this.snapshot<CategoryRow>(catalogKeys.categoryTree(), this.categories);
      if (rows !== undefined) return contextFromRows(rows, id);
    }
    return this.internal<CategoryContext>(`/internal/catalog/categories/${id}/context`);
  }

  async brand(id: string, { fresh = false } = {}): Promise<BrandRef | null> {
    if (!fresh) {
      const rows = await this.snapshot<BrandRow>(catalogKeys.brands(), this.brands);
      const row = rows?.find((b) => b.id === id);
      if (row !== undefined) return { ...row, isActive: true };
    }
    return this.internal<BrandRef>(`/internal/catalog/brands/${id}`);
  }

  /** Category id for a slug (snapshot). */
  async categoryIdBySlug(slug: string): Promise<string | null> {
    const rows = await this.snapshot<CategoryRow>(catalogKeys.categoryTree(), this.categories);
    return rows?.find((row) => row.slug === slug)?.id ?? null;
  }

  /** Every category whose whole ancestor chain is active; undefined when the snapshot is down. */
  async visibleCategoryIds(): Promise<Set<string> | undefined> {
    const rows = await this.snapshot<CategoryRow>(catalogKeys.categoryTree(), this.categories);
    if (rows === undefined) return undefined;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return new Set(
      rows
        .filter((row) => pathIdsOf(row.path).every((id) => byId.get(id)?.isActive === true))
        .map((row) => row.id),
    );
  }

  /** Active brands (the snapshot holds active brands only); undefined when it is down. */
  async activeBrands(): Promise<Map<string, BrandRow> | undefined> {
    const rows = await this.snapshot<BrandRow>(catalogKeys.brands(), this.brands);
    return rows === undefined ? undefined : new Map(rows.map((b) => [b.id, b]));
  }

  /** Brand ids whose name/code matches `q` (storefront search on brand). Snapshot only. */
  async brandIdsMatching(q: string): Promise<string[]> {
    const rows = (await this.snapshot<BrandRow>(catalogKeys.brands(), this.brands)) ?? [];
    const needle = q.toLowerCase();
    return rows
      .filter((b) => b.name.toLowerCase().includes(needle) || b.code.toLowerCase().includes(needle))
      .map((b) => b.id);
  }

  /** Throws 422 unless the category can take products (live and effectively active). */
  async assertAssignableCategory(id: string): Promise<CategoryContext> {
    const ctx = await this.categoryContext(id, { fresh: true });
    if (!ctx?.effectiveActive) {
      throw new ValidationError([
        { path: 'categoryId', message: 'Category not found or inactive' },
      ]);
    }
    return ctx;
  }

  /** Throws 422 unless the brand can take products. */
  async assertAssignableBrand(id: string): Promise<BrandRef> {
    const brand = await this.brand(id, { fresh: true });
    if (!brand?.isActive) {
      throw new ValidationError([{ path: 'brandId', message: 'Brand not found or inactive' }]);
    }
    return brand;
  }
}
