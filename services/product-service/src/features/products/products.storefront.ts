import { createHash } from 'node:crypto';

import { NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { productKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { BrandRow, Crumb } from '../../adapters/catalog-client.js';
import type { EffectiveAttribute } from '../attributes/index.js';
import type { StorefrontFilter } from './products.repository.js';
import type {
  ProductCard,
  ProductFilterQuery,
  PublicListQuery,
  PublicSort,
} from './products.types.js';
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
  | 'diseasesService'
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
  /** Products matching the whole selection ("Show X products"). */
  total: number;
  /** Sort chips (server-driven order); the list's default is `relevance`. */
  sort: { code: PublicSort; label: string }[];
  attributes: Pick<EffectiveAttribute, 'key' | 'label' | 'dataType' | 'unit' | 'options'>[];
  dosageForms: { code: string; label: string }[];
  routes: { code: string; label: string }[];
  /** Every SPECIES chip; productCount ignores the species selection itself (0 = greyed out). */
  species: { code: string; label: string; productCount: number }[];
  flockStages: { code: string; label: string }[];
  /** Active diseases with products under the other filters, plus any selected one (even at 0). */
  diseases: { id: string; slug: string; name: string; productCount: number }[];
  /** "Manufacturer" facet: brands under the other filters, plus any selected one (even at 0). */
  brands: { id: string; name: string; productCount: number }[];
  priceRange: { min: string | null; max: string | null };
  /** "In stock at <node>" count for the given `nodeId` (all other filters applied); null = none. */
  node: { id: string; productCount: number } | null;
  /** "Covered by my prescriptions": not available until the Rx service exists. */
  rx: { available: boolean };
}

/** A list page plus the number of products matching the selection (capped at 2,000). */
export type StorefrontPage = Paginated<ProductCard> & { total: number };

const SORT_OPTIONS: FiltersView['sort'] = [
  { code: 'price_desc', label: 'High - Low Price' },
  { code: 'price_asc', label: 'Low - High Price' },
  { code: 'shelf_life', label: 'Shelf life' },
];

/** A selection resolved against catalog snapshots, lookups and diseases. */
interface Resolved {
  filter: StorefrontFilter;
  /** True when the selection can match nothing (unknown category slug, no live disease…). */
  empty: boolean;
  /** Effective attribute definitions of the selected category. */
  attrDefs: EffectiveAttribute[];
  /** Active brands (catalog snapshot); undefined = snapshot unavailable → no brand restriction. */
  brands: Map<string, BrandRow> | undefined;
  /** Ranked text-search candidates; undefined = no text search. */
  candidates: string[] | undefined;
}

/** The filter without some dimensions (a facet's counts ignore its own selection). */
const omit = (f: StorefrontFilter, keys: readonly (keyof StorefrontFilter)[]): StorefrontFilter =>
  Object.fromEntries(
    Object.entries(f).filter(([k]) => !keys.includes(k as keyof StorefrontFilter)),
  ) as unknown as StorefrontFilter;

const hashQuery = (query: object): string =>
  createHash('sha1')
    .update(
      JSON.stringify(
        Object.entries(query as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]): [string, unknown] => [
            k,
            Array.isArray(v) ? (v as unknown[]).map(String).sort() : v,
          ])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest('base64url');

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

  async list(query: PublicListQuery): Promise<StorefrontPage> {
    const version = await this.listVersion();
    return this.deps.cache.getOrSet(
      productKeys.list(version, hashQuery(query)),
      LIST_TTL_SECONDS,
      () => this.load(query),
    );
  }

  private async listVersion(): Promise<string> {
    return (await this.deps.redis.get(productKeys.listVersion()).catch(() => null)) ?? '0';
  }

  /**
   * One selection → StorefrontFilter, shared by the list and its facets so counts always match
   * what a tap returns. Visibility: category effectively active + brand active (snapshots).
   */
  private async resolve(query: ProductFilterQuery): Promise<Resolved> {
    const { catalogClient, productsRepository: repo } = this.deps;
    const [visible, brands] = await Promise.all([
      catalogClient.visibleCategoryIds(),
      catalogClient.activeBrands(),
    ]);
    const activeBrandIds = brands === undefined ? undefined : new Set(brands.keys());
    let attrDefs: EffectiveAttribute[] = [];
    const nothing = (): Resolved => ({
      filter: { ids: [], attrs: [] },
      empty: true,
      attrDefs,
      brands,
      candidates: undefined,
    });

    // Category (+ all sub-categories at any depth).
    let categoryIds: string[] | undefined = visible === undefined ? undefined : [...visible];
    const categoryId =
      query.categoryId ??
      (query.categorySlug === undefined
        ? undefined
        : await catalogClient.categoryIdBySlug(query.categorySlug));
    if (query.categorySlug !== undefined && categoryId === null) return nothing();
    if (categoryId !== undefined && categoryId !== null) {
      const ctx = await catalogClient.categoryContext(categoryId);
      if (ctx === null) return nothing();
      categoryIds = intersect(ctx.subtreeIds, visible);
      attrDefs = await this.deps.attributesService.effectiveFor(ctx.pathIds);
    }
    const attrs = parseAttrFilters(query as unknown as Record<string, unknown>, attrDefs);

    // Disease chips / Shop by Problem: slugs resolve to live, active diseases only.
    let diseaseIds = query.diseaseId;
    if (query.diseaseSlug !== undefined) {
      diseaseIds = await this.deps.diseasesService.activeIdsBySlugs(query.diseaseSlug);
      if (diseaseIds.length === 0) return nothing();
    }

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
      ...(diseaseIds === undefined ? {} : { diseaseIds }),
      ...(query.flockStage === undefined ? {} : { flockStages: query.flockStage }),
      ...(query.isPrescriptionRequired === undefined
        ? {}
        : { isPrescriptionRequired: query.isPrescriptionRequired }),
      ...(query.temperatureClass === undefined ? {} : { temperatureClass: query.temperatureClass }),
      ...(query.inStock === undefined ? {} : { inStock: query.inStock }),
      ...(query.nodeId === undefined ? {} : { nodeId: query.nodeId }),
      ...(query.minPrice === undefined ? {} : { minPrice: query.minPrice }),
      ...(query.maxPrice === undefined ? {} : { maxPrice: query.maxPrice }),
      ...(query.minRating === undefined ? {} : { minRating: query.minRating }),
      ...(query.isFeatured === undefined ? {} : { isFeatured: query.isFeatured }),
      attrs,
    };
    return { filter, empty: false, attrDefs, brands, candidates };
  }

  private async load(query: PublicListQuery): Promise<StorefrontPage> {
    const repo = this.deps.productsRepository;
    const empty = { items: [], nextCursor: null, limit: query.limit, total: 0 };
    const r = await this.resolve(query);
    if (r.empty) return empty;
    const sort: PublicSort = query.sort ?? 'relevance';
    let ids = await repo.storefrontIds(repo.storefrontWhere(r.filter), sort);
    if (r.candidates !== undefined && sort === 'relevance') {
      const rank = new Map(r.candidates.map((id, i) => [id, i]));
      ids = [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    }
    const start = query.cursor === undefined ? 0 : ids.indexOf(query.cursor) + 1;
    if (query.cursor !== undefined && start === 0) return { ...empty, total: ids.length };
    const pageIds = ids.slice(start, start + query.limit);
    const byId = new Map((await repo.cards(pageIds)).map((c) => [c.id, toCard(c)]));
    const items = pageIds.flatMap((id) => {
      const card = byId.get(id);
      return card === undefined ? [] : [card];
    });
    const hasMore = start + query.limit < ids.length;
    return {
      items,
      nextCursor: hasMore ? (pageIds.at(-1) ?? null) : null,
      limit: query.limit,
      total: ids.length,
    };
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
    const stages = await this.deps.lookupsService.publicList('FLOCK_STAGE');
    const view = toPublicDetail(
      toProductView(record, new Map(stages.map((s) => [s.code, s.label]))),
    );
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

  /**
   * Facets for the Filter & sort sheet under the CURRENT selection (same query as the list).
   * Disjunctive counts: each multi-select facet ignores its own dimension, so picking "Layer" still
   * shows how many products the other species chips would add. Cached 60 s per selection.
   */
  async filters(query: ProductFilterQuery): Promise<FiltersView> {
    const version = await this.listVersion();
    return this.deps.cache.getOrSet(
      productKeys.filters(version, hashQuery(query)),
      LIST_TTL_SECONDS,
      () => this.loadFilters(query),
    );
  }

  private async loadFilters(query: ProductFilterQuery): Promise<FiltersView> {
    const { productsRepository: repo, lookupsService, diseasesService } = this.deps;
    const r = await this.resolve(query);
    const f = r.filter;
    const where = (x: StorefrontFilter) => repo.storefrontWhere(x);
    const activeBrandIds = r.brands === undefined ? undefined : [...r.brands.keys()];
    const brandFilter: StorefrontFilter = {
      ...omit(f, ['brandIds']),
      ...(activeBrandIds === undefined ? {} : { brandIds: activeBrandIds }),
    };
    const nodeId = query.nodeId;

    const [facets, lookups, diseases, diseaseCounts, speciesCounts, total, nodeCount] =
      await Promise.all([
        repo.facets(where(brandFilter), where(omit(f, ['minPrice', 'maxPrice']))),
        lookupsService.publicList(undefined),
        diseasesService.activeAll(),
        diseasesService.productCounts(where(omit(f, ['diseaseIds']))),
        repo.speciesCounts(where(omit(f, ['species']))),
        repo.count(where(f)),
        nodeId === undefined
          ? Promise.resolve(null)
          : repo.count(where({ ...f, inStock: true, nodeId })),
      ]);

    const pick = (group: string) =>
      lookups.filter((l) => l.group === group).map(({ code, label }) => ({ code, label }));
    const selectedDiseases = new Set(f.diseaseIds ?? []);
    const brands = facets.brands.map((b) => ({
      id: b.brandId,
      name: b.brandName,
      productCount: b._count._all,
    }));
    const listed = new Set(brands.map((b) => b.id));
    for (const id of query.brandId ?? []) {
      const brand = r.brands?.get(id);
      if (!listed.has(id) && brand !== undefined)
        brands.push({ id, name: brand.name, productCount: 0 });
    }

    return {
      total,
      sort: SORT_OPTIONS,
      attributes: r.attrDefs
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
      species: pick('SPECIES').map((s) => ({
        ...s,
        productCount: speciesCounts.get(s.code) ?? 0,
      })),
      flockStages: pick('FLOCK_STAGE'),
      diseases: diseases.flatMap(({ id, slug, name }) => {
        const productCount = diseaseCounts.get(id) ?? 0;
        return productCount === 0 && !selectedDiseases.has(id)
          ? []
          : [{ id, slug, name, productCount }];
      }),
      brands: brands.sort((a, b) => a.name.localeCompare(b.name)),
      priceRange: {
        min: facets.minPrice === null ? null : Number(facets.minPrice.toString()).toFixed(2),
        max: facets.maxPrice === null ? null : Number(facets.maxPrice.toString()).toFixed(2),
      },
      node:
        nodeId === undefined || nodeCount === null ? null : { id: nodeId, productCount: nodeCount },
      rx: { available: false },
    };
  }
}
