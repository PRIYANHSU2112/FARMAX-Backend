import { performance } from 'node:perf_hooks';

import { userKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { CatalogBrand, CatalogCategory } from '../../adapters/catalog-client.js';
import type { FlockStage, PublicDisease } from '../../adapters/product-client.js';
import { type Remembered, before } from './home.service.js';
import type { CategoriesPageView, CategoryPagePart, HomeContext, HomeMeta } from './home.types.js';

type Deps = Pick<Cradle, 'homeService' | 'catalogClient' | 'productClient'>;

/** Per upstream call. */
const UPSTREAM_TIMEOUT_MS = 300;
/** Whole page: a part not ready by then is left empty (`meta.degraded`), never a 5xx. */
const PAGE_BUDGET_MS = 350;
/** Client refresh hint (the data itself is cached 60 s). */
const TTL_SECONDS = 60;
const MAX_CATEGORIES = 50;
const MAX_PROBLEMS = 12;
const MAX_MAKERS = 9;

type CatalogKind = Parameters<typeof userKeys.homeCatalog>[0];

/** Upstream data behind each part, cached under `home:cat:<kind>:<id>` (shared by all callers). */
interface Parts {
  categories: CatalogCategory[];
  stages: FlockStage[];
  problems: PublicDisease[];
  makers: CatalogBrand[];
}

// ── Pure helpers (exported for unit tests) ──

/** Avatar fallback text: "Godavari Bio" → "GB", "Coastal" → "CO", "" → "". */
export const initialsOf = (name: string): string => {
  const [first = '', second] = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const head = Array.from(first);
  const text =
    second === undefined
      ? head.slice(0, 2).join('')
      : `${head[0] ?? ''}${Array.from(second)[0] ?? ''}`;
  return text.toUpperCase();
};

/** Maps the cached upstream data + the caller's farm to the page (new objects per request). */
export const toCategoriesView = (
  parts: { [K in keyof Parts]: Parts[K] | null },
  ctx: Pick<HomeContext, 'farm'>,
): CategoriesPageView => ({
  categories: (parts.categories ?? []).slice(0, MAX_CATEGORIES).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    imageUrl: c.imageUrl,
    subtitle: null,
    badge: null,
    deepLink: `farmx://category/${c.slug}`,
  })),
  flock: {
    stages: (parts.stages ?? []).map((s) => ({
      code: s.code,
      label: s.label,
      deepLink: `farmx://products?flockStage=${s.code}`,
    })),
    currentStage: null,
    shedLabel: null,
    ageWeeks: null,
    birdCount: ctx.farm?.totalBirdCapacity ?? null,
    productsForStage: null,
  },
  problems: (parts.problems ?? []).slice(0, MAX_PROBLEMS).map((d) => ({
    id: d.id,
    name: d.name,
    slug: d.slug,
    iconUrl: d.iconUrl,
    productCount: d.productCount,
    deepLink: `farmx://products?diseaseSlug=${d.slug}`,
  })),
  makers: (parts.makers ?? []).slice(0, MAX_MAKERS).map((b) => ({
    id: b.id,
    name: b.name,
    slug: b.slug,
    logoUrl: b.logoUrl,
    initials: initialsOf(b.name),
    deepLink: `farmx://products?brandId=${b.id}`,
  })),
});

/**
 * All Categories screen in ONE call: root categories, flock-stage chips (+ the farmer's bird
 * count), Shop by Problem and Verified makers. The four shared parts load in parallel through
 * `HomeService.remember` (hot 5 s → Redis 60 s → upstream → 10-min stale copy), with one
 * in-flight load per part per instance (a cold burst = 1 upstream call). The personal part comes
 * from the already-built context (no extra call).
 */
export class HomeCategoriesService {
  private readonly inflight = new Map<CategoryPagePart, Promise<Remembered<unknown> | null>>();

  constructor(private readonly deps: Deps) {}

  async page(ctx: HomeContext): Promise<{ view: CategoriesPageView; meta: HomeMeta }> {
    const started = performance.now();
    const meta: HomeMeta = {
      authState: ctx.authState,
      region: ctx.region,
      degraded: [],
      stale: [],
      ttlSeconds: TTL_SECONDS,
      timings: {},
    };
    const deadline = Date.now() + PAGE_BUDGET_MS;
    const { catalogClient: catalog, productClient: product } = this.deps;
    const t = UPSTREAM_TIMEOUT_MS;

    const [categories, stages, problems, makers] = await Promise.all([
      // Same key as the home layout's CATALOG_CATEGORIES section: one shared copy.
      this.part('categories', ['categories', 'roots'], deadline, meta, () => catalog.categories(t)),
      this.part('stages', ['stages', 'flock'], deadline, meta, () => product.flockStages(t)),
      this.part('problems', ['diseases', 'non-empty'], deadline, meta, () =>
        product.diseases(t, true),
      ),
      this.part('makers', ['brands', `featured-${String(MAX_MAKERS)}`], deadline, meta, () =>
        catalog.featuredBrands(MAX_MAKERS, t),
      ),
    ]);

    const view = toCategoriesView({ categories, stages, problems, makers }, ctx);
    meta.timings = { ...meta.timings, total: Math.round(performance.now() - started) };
    return { view, meta };
  }

  /** One part: shared single-flight load, bounded by the page deadline. null = degraded. */
  private async part<T>(
    name: CategoryPagePart,
    [kind, id]: [CatalogKind, string],
    deadline: number,
    meta: HomeMeta,
    fetch: () => Promise<T>,
  ): Promise<T | null> {
    const started = performance.now();
    let flight = this.inflight.get(name) as Promise<Remembered<T> | null> | undefined;
    if (flight === undefined) {
      const load = this.deps.homeService
        .remember(userKeys.homeCatalog(kind, id), userKeys.homeCatalog(kind, id, true), fetch)
        .finally(() => this.inflight.delete(name));
      this.inflight.set(name, load);
      flight = load;
    }
    const got = await before(flight, deadline);
    meta.timings = { ...meta.timings, [name]: Math.round(performance.now() - started) };
    if (got === undefined || got === null) {
      meta.degraded.push(name);
      return null;
    }
    if (got.stale) meta.stale.push(name);
    return got.value;
  }
}
