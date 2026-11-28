import type { UserConfig } from '../config/index.js';
import { UpstreamError, getJson } from './http.js';

/** catalog-service public banner (passed through). */
export interface CatalogBanner {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  mobileImageUrl: string | null;
  actionType: string;
  actionTarget: string | null;
  sortOrder: number;
}

/** catalog-service public placement with its live banners (schedule already applied there). */
export interface CatalogPlacement {
  code: string;
  aspectRatio: string;
  maxItems: number;
  banners: CatalogBanner[];
}

/** catalog-service public category node (`GET /catalog/categories`). */
export interface CatalogCategory {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  imageUrl: string | null;
  depth: number;
  sortOrder: number;
  childCount: number;
  children?: CatalogCategory[];
}

/** catalog-service public brand (`GET /catalog/brands`), the fields the app shows. */
export interface CatalogBrand {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

interface Envelope<T> {
  data: T;
}

/** Deepest tree the public endpoint returns in one call (catalog caps `maxDepth`). */
const TREE_DEPTH = 5;

/**
 * catalog-service PUBLIC API (no token): banner placements, the category tree, brands. Callers
 * (home feature) add caching and fallbacks; this class only does HTTP with a timeout.
 */
export class CatalogClient {
  constructor(private readonly deps: { config: UserConfig }) {}

  private url(path: string): string {
    return `${this.deps.config.CATALOG_SERVICE_URL}${path}`;
  }

  /** null = the placement does not exist (or is inactive). */
  async placement(code: string, timeoutMs: number): Promise<CatalogPlacement | null> {
    try {
      const body = await getJson<Envelope<CatalogPlacement>>(
        this.url(`/catalog/banners/placements/${encodeURIComponent(code)}`),
        { timeoutMs },
      );
      return body.data;
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return null;
      throw err;
    }
  }

  /** Root categories with `maxDepth` levels of children (storefront-visible only). */
  async categories(timeoutMs: number, maxDepth = 1): Promise<CatalogCategory[]> {
    const body = await getJson<Envelope<CatalogCategory[]>>(
      this.url(`/catalog/categories?maxDepth=${String(Math.min(maxDepth, TREE_DEPTH))}`),
      { timeoutMs },
    );
    return body.data;
  }

  /** Every visible category id (whole tree), for the admin ref check. */
  async categoryIds(timeoutMs: number): Promise<Set<string>> {
    const ids = new Set<string>();
    const walk = (nodes: readonly CatalogCategory[]) => {
      for (const node of nodes) {
        ids.add(node.id);
        if (node.children !== undefined) walk(node.children);
      }
    };
    walk(await this.categories(timeoutMs, TREE_DEPTH));
    return ids;
  }

  /** First `limit` featured, active brands (catalog order: sortOrder, then name). */
  async featuredBrands(limit: number, timeoutMs: number): Promise<CatalogBrand[]> {
    const body = await getJson<Envelope<CatalogBrand[]>>(
      this.url(`/catalog/brands?isFeatured=true&limit=${String(limit)}`),
      { timeoutMs },
    );
    return body.data.map(({ id, name, slug, logoUrl }) => ({ id, name, slug, logoUrl }));
  }

  /** true = the brand is live and active; false = 404 (gone). Throws when catalog is down. */
  async brandExists(id: string, timeoutMs: number): Promise<boolean> {
    try {
      await getJson(this.url(`/catalog/brands/${encodeURIComponent(id)}`), { timeoutMs });
      return true;
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return false;
      throw err;
    }
  }
}
