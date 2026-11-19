import { createHash } from 'node:crypto';

import { NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { productKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { Crumb } from '../../adapters/catalog-client.js';
import type { EffectiveAttribute } from '../attributes/index.js';
import type { StorefrontFilter } from './products.repository.js';
import type { ProductCard, PublicListQuery, PublicSort } from './products.types.js';
import {
  type PublicProductDetail,
  toCard,
  toProductView,
  toPublicDetail,
} from './products.views.js';

type Deps = Pick<
  Cradle,
  | 'productsRepository'
  | 'catalogClient'
  | 'attributesService'
  | 'lookupsService'
  | 'cache'
  | 'redis'
>;

const LIST_TTL_SECONDS = 60;
const DETAIL_TTL_SECONDS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicDetailView extends PublicProductDetail {
  category: { id: string; breadcrumb: Crumb[] };
  brand: { id: string; name: string; slug: string | null; logoUrl: string | null };
}

export interface FiltersView {
  attributes: Pick<EffectiveAttribute, 'key' | 'label' | 'dataType' | 'unit' | 'options'>[];
  dosageForms: { code: string; label: string }[];
  routes: { code: string; label: string }[];
  species: { code: string; label: string }[];
  brands: { id: string; name: string; productCount: number }[];
  priceRange: { min: string | null; max: string | null };
}

const intersect = (a: readonly string[], b: Set<string> | undefined) =>
  b === undefined ? [...a] : a.filter((id) => b.has(id));

/** Coerces `attr.<key>` query values by the attribute's data type; unknown keys → 422. */
export const parseAttrFilters = (
  query: Record<string, unknown>,
  defs: readonly EffectiveAttribute[],
): StorefrontFilter['attrs'] => {
  const filterable = new Map(defs.filter((d) => d.isFilterable).map((d) => [d.key, d]));
  const attrs: StorefrontFilter['attrs'] = [];
  const issues: { path: string; message: string }[] = [];
  for (const [name, raw] of Object.entries(query)) {
    if (!name.startsWith('attr.') || raw === undefined) continue;
    const key = name.slice(5);
    const def = filterable.get(key);
    if (def === undefined) {
      issues.push({ path: name, message: 'Not a filterable attribute of this category' });
      continue;
    }
    const values = (Array.isArray(raw) ? raw : [raw]).map(String);
    const coerced = values.map((v) =>
      def.dataType === 'NUMBER' ? Number(v) : def.dataType === 'BOOLEAN' ? v === 'true' : v,
    );
    if (def.dataType === 'NUMBER' && coerced.some((v) => Number.isNaN(v)))
      issues.push({ path: name, message: 'Must be a number' });
    attrs.push({ key, values: coerced, multi: def.dataType === 'MULTI_SELECT' });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return attrs;
};

/**
 * Storefront reads. Lists are cached 60 s per normalised query under a version that every product
 * write bumps (no key scans); details 10 min per slug. Visibility = published + active + active
 * variant + category effectively active + brand active (catalog snapshots).
 */
export class StorefrontService {
  constructor(private readonly deps: Deps) {}

  async list(query: PublicListQuery): Promise<Paginated<ProductCard>> {
    const version = (await this.deps.redis.get(productKeys.listVersion()).catch(() => null)) ?? '0';
    const hash = createHash('sha1')
      .update(JSON.stringify(Object.entries(query).sort(([a], [b]) => a.localeCompare(b))))
      .digest('base64url');
    return this.deps.cache.getOrSet(productKeys.list(version, hash), LIST_TTL_SECONDS, () =>
      this.load(query),
    );
  }

  private async load(query: PublicListQuery): Promise<Paginated<ProductCard>> {
    const { catalogClient, productsRepository: repo } = this.deps;
    const [visible, brands] = await Promise.all([
      catalogClient.visibleCategoryIds(),
      catalogClient.activeBrands(),
    ]);
    const activeBrandIds = brands === undefined ? undefined : new Set(brands.keys());

    // Category (+ all sub-categories at any depth).
    let categoryIds: string[] | undefined = visible === undefined ? undefined : [...visible];
    let attrDefs: EffectiveAttribute[] = [];
    const categoryId =
      query.categoryId ??
      (query.categorySlug === undefined
        ? undefined
        : await catalogClient.categoryIdBySlug(query.categorySlug));
    if (query.categorySlug !== undefined && categoryId === null)
      return { items: [], nextCursor: null, limit: query.limit };
    if (categoryId !== undefined && categoryId !== null) {
      const ctx = await catalogClient.categoryContext(categoryId);
      if (ctx === null) return { items: [], nextCursor: null, limit: query.limit };
      categoryIds = intersect(ctx.subtreeIds, visible);
      attrDefs = await this.deps.attributesService.effectiveFor(ctx.pathIds);
    }
    const attrs = parseAttrFilters(query as unknown as Record<string, unknown>, attrDefs);

    const q = query.q?.trim();
    const candidates = q === undefined || q === '' ? undefined : await repo.searchCandidates(q);
    const filter: StorefrontFilter = {
      ...(candidates === undefined ? {} : { ids: candidates }),
      ...(categoryIds === undefined ? {} : { categoryIds }),
      ...(query.brandId === undefined && activeBrandIds === undefined
        ? {}
        : { brandIds: intersect(query.brandId ?? [...(activeBrandIds ?? [])], activeBrandIds) }),
      ...(query.dosageForm === undefined ? {} : { dosageForm: query.dosageForm }),
      ...(query.species === undefined ? {} : { species: query.species }),
      ...(query.route === undefined ? {} : { route: query.route }),
      ...(query.isPrescriptionRequired === undefined
        ? {}
        : { isPrescriptionRequired: query.isPrescriptionRequired }),
      ...(query.temperatureClass === undefined ? {} : { temperatureClass: query.temperatureClass }),
      ...(query.inStock === undefined ? {} : { inStock: query.inStock }),
      ...(query.minPrice === undefined ? {} : { minPrice: query.minPrice }),
      ...(query.maxPrice === undefined ? {} : { maxPrice: query.maxPrice }),
      ...(query.isFeatured === undefined ? {} : { isFeatured: query.isFeatured }),
      attrs,
    };
    const sort: PublicSort = query.sort ?? (candidates === undefined ? 'relevance' : 'relevance');
    let ids = await repo.storefrontIds(repo.storefrontWhere(filter), sort);
    if (candidates !== undefined && sort === 'relevance') {
      const rank = new Map(candidates.map((id, i) => [id, i]));
      ids = [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    }
    const start = query.cursor === undefined ? 0 : ids.indexOf(query.cursor) + 1;
    if (query.cursor !== undefined && start === 0)
      return { items: [], nextCursor: null, limit: query.limit };
    const pageIds = ids.slice(start, start + query.limit);
    const byId = new Map((await repo.cards(pageIds)).map((c) => [c.id, toCard(c)]));
    const items = pageIds.flatMap((id) => {
      const card = byId.get(id);
      return card === undefined ? [] : [card];
    });
    const hasMore = start + query.limit < ids.length;
    return { items, nextCursor: hasMore ? (pageIds.at(-1) ?? null) : null, limit: query.limit };
  }

  async detail(slugOrId: string): Promise<PublicDetailView> {
    const view = UUID.test(slugOrId)
      ? await this.loadDetail({ id: slugOrId })
      : await this.deps.cache.getOrSet(productKeys.product(slugOrId), DETAIL_TTL_SECONDS, () =>
          this.loadDetail({ slug: slugOrId }),
        );
    if (view === null) throw new NotFoundError('Product');
    // Visibility can change without a product write (category/brand toggled) → checked per read.
    const [visible, brands] = await Promise.all([
      this.deps.catalogClient.visibleCategoryIds(),
      this.deps.catalogClient.activeBrands(),
    ]);
    if (visible !== undefined && !visible.has(view.category.id)) throw new NotFoundError('Product');
    if (brands !== undefined && !brands.has(view.brand.id)) throw new NotFoundError('Product');
    const brand = brands?.get(view.brand.id);
    return brand === undefined
      ? view
      : {
          ...view,
          brand: { id: brand.id, name: brand.name, slug: brand.slug, logoUrl: brand.logoUrl },
        };
  }

  private async loadDetail(
    where: { id: string } | { slug: string },
  ): Promise<PublicDetailView | null> {
    const record = await this.deps.productsRepository.findDetailBy(where);
    if (record?.status !== 'PUBLISHED' || !record.isActive) return null;
    const view = toPublicDetail(toProductView(record));
    if (view.variants.length === 0) return null;
    const ctx = await this.deps.catalogClient.categoryContext(record.categoryId);
    return {
      ...view,
      category: { id: record.categoryId, breadcrumb: ctx?.breadcrumb ?? [] },
      brand: { id: record.brandId, name: record.brandName, slug: null, logoUrl: null },
    };
  }

  /**
   * Internal (user-service wishlist): the storefront card of each known id plus `available`
   * (published, active, not deleted, category visible). Unknown ids are left out.
   */
  async internalCards(ids: readonly string[]): Promise<(ProductCard & { available: boolean })[]> {
    const [rows, visible] = await Promise.all([
      this.deps.productsRepository.internalCards(ids),
      this.deps.catalogClient.visibleCategoryIds(),
    ]);
    return rows.map((row) => ({
      ...toCard(row),
      available:
        row.status === 'PUBLISHED' &&
        row.isActive &&
        row.deletedAt === null &&
        (visible === undefined || visible.has(row.categoryId)),
    }));
  }

  async alternatives(slugOrId: string): Promise<ProductCard[]> {
    const view = await this.detail(slugOrId);
    const ids = await this.deps.productsRepository.alternatives(
      view.id,
      view.ingredients.map((i) => i.name),
    );
    const visible = await this.deps.catalogClient.visibleCategoryIds();
    const cards = (await this.deps.productsRepository.cards(ids)).map(toCard);
    return cards.filter((c) => visible === undefined || visible.has(c.categoryId));
  }

  async filters(categoryId: string | undefined): Promise<FiltersView> {
    const { catalogClient, productsRepository: repo } = this.deps;
    const visible = await catalogClient.visibleCategoryIds();
    let categoryIds = visible === undefined ? undefined : [...visible];
    let defs: EffectiveAttribute[] = [];
    if (categoryId !== undefined) {
      const ctx = await catalogClient.categoryContext(categoryId);
      if (ctx === null) throw new NotFoundError('Category');
      categoryIds = intersect(ctx.subtreeIds, visible);
      defs = await this.deps.attributesService.effectiveFor(ctx.pathIds);
    }
    const where = repo.storefrontWhere({
      ...(categoryIds === undefined ? {} : { categoryIds }),
      attrs: [],
    });
    const [facets, lookups] = await Promise.all([
      repo.facets(where),
      this.deps.lookupsService.publicList(undefined),
    ]);
    const pick = (group: string) =>
      lookups.filter((l) => l.group === group).map(({ code, label }) => ({ code, label }));
    return {
      attributes: defs
        .filter((d) => d.isFilterable)
        .map(({ key, label, dataType, unit, options }) => ({
          key,
          label,
          dataType,
          unit,
          options,
        })),
      dosageForms: pick('DOSAGE_FORM'),
      routes: pick('ROUTE'),
      species: pick('SPECIES'),
      brands: facets.brands
        .map((b) => ({ id: b.brandId, name: b.brandName, productCount: b._count._all }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      priceRange: {
        min: facets.minPrice === null ? null : Number(facets.minPrice.toString()).toFixed(2),
        max: facets.maxPrice === null ? null : Number(facets.maxPrice.toString()).toFixed(2),
      },
    };
  }
}
