import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { userKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { CatalogCategory, CatalogPlacement } from '../../adapters/catalog-client.js';
import { LocalCache } from '../../adapters/local-cache.js';
import type { ProductCard } from '../../adapters/product-client.js';
import type { Actor } from '../audit/index.js';
import { FEED_DEFS } from './home.feeds.js';
import {
  type CompiledSection,
  type CompiledSnapshot,
  type RuleFacts,
  bucketFor,
  compileSnapshot,
  factsOf,
  localize,
  localizeDeep,
  matches,
  trackingId,
  visibleSections,
} from './home.rules.js';
import {
  type FeedKey,
  type HomeContext,
  type HomeMeta,
  type HomePage,
  type HomeProductCard,
  type ImageRef,
  type ImageView,
  type ItemRow,
  type ItemView,
  type LayoutRow,
  type LayoutStatus,
  type LayoutTree,
  type LayoutView,
  PRODUCT_SOURCES,
  type ProductPage,
  SCHEMA_VERSION,
  type SectionRow,
  type SectionView,
  type Snapshot,
} from './home.types.js';
import { LIMITS } from './home.validation.js';
import { PROMO_WIDGETS } from './home.widgets.js';

type Deps = Pick<
  Cradle,
  | 'homeRepository'
  | 'productClient'
  | 'catalogClient'
  | 'cache'
  | 'redis'
  | 'logger'
  | 'runInTransaction'
  | 'auditService'
>;

const LAYOUT_TTL_SECONDS = 30;
const LOCAL_TTL_MS = 5_000;
const DATA_TTL_SECONDS = 60;
const STALE_TTL_SECONDS = 600;
const PRODUCT_TIMEOUT_MS = 350;
const CATALOG_TIMEOUT_MS = 300;
const INLINE_BUDGET_MS = 350;

/** Audit actor of the lazy scheduled-layout flip (no human request). */
export const SYSTEM_ACTOR: Actor = {
  userId: '00000000-0000-0000-0000-000000000000',
  ip: '127.0.0.1',
  requestId: 'home-scheduler',
};

/** Raw page of product cards as cached (decorated per request: tracking, actions, phone). */
interface RawProductPage {
  items: ProductCard[];
  nextCursor: string | null;
  inStockAtDepot: boolean | null;
}

interface CachedLayout {
  snap: Snapshot | null;
  nextScheduledAt: number | null;
}

export interface Remembered<T> {
  value: T;
  stale: boolean;
}

interface AssembleOptions {
  /** false = admin preview: never read or write caches, never serve stale data. */
  cache: boolean;
}

// ── Pure helpers (exported for unit tests) ──

export const toSnapshot = (tree: LayoutTree, nextScheduledAt: Date | null): Snapshot => ({
  layoutId: tree.id,
  page: tree.page,
  layoutNo: tree.layoutNo,
  publishRev: tree.publishRev ?? 0,
  settings: tree.settings,
  sections: tree.sections,
  nextScheduledAt: nextScheduledAt?.getTime() ?? null,
});

export const isProductSource = (s: SectionRow): boolean => PRODUCT_SOURCES.includes(s.dataSource);

/** Order-by-phone number for the caller's region, else the page default, else none. */
export const phoneFor = (snap: Snapshot, region: string | null): string | null =>
  (region === null ? undefined : snap.settings.orderPhones?.byRegion?.[region]) ??
  snap.settings.orderPhones?.default ??
  null;

export const imageView = (image: ImageRef | null): ImageView | null =>
  image === null
    ? null
    : {
        ...image,
        aspectRatio:
          image.width !== undefined && image.height !== undefined
            ? Math.round((image.width / image.height) * 1000) / 1000
            : null,
        variants: null,
        blurHash: null,
      };

/** Adds tracking + the card buttons (Add / Upload Rx, call to order) to a product-service card. */
export const decorateCard = (
  card: ProductCard,
  ids: { page: string; layoutNo: number; sectionKey: string },
  tel: string | null,
  inStockAtDepot: boolean | null,
): HomeProductCard => {
  const rx = card.isPrescriptionRequired === true;
  return {
    ...card,
    tracking: { id: trackingId(ids.page, ids.layoutNo, ids.sectionKey, card.id) },
    actions: {
      primary: rx ? 'UPLOAD_RX' : 'ADD_TO_CART',
      uploadRxLink: rx ? `farmx://rx/upload?productId=${card.id}` : null,
      call: tel === null ? null : { type: 'PHONE_ORDER', tel },
    },
    priceBreak: card.priceBreak ?? null,
    inStockAtDepot,
  };
};

/** product-service cursors are opaque: hash them into a Redis-key-safe part. */
export const cursorKey = (cursor: string | undefined): string =>
  cursor === undefined ? '-' : createHash('sha1').update(cursor).digest('hex').slice(0, 20);

/** Resolves with the value, or `undefined` once `deadline` (epoch ms) passes. Never rejects. */
export const before = <T>(work: Promise<T>, deadline: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        resolve(undefined);
      },
      Math.max(0, deadline - Date.now()),
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });

const productQuery = (
  section: SectionRow,
  nodeId: string | null,
  cursor: string | undefined,
  limit: number,
): { query: Record<string, string | number | boolean | string[]>; atDepot: boolean } => {
  const saved = (section.config.query ?? {}) as Record<
    string,
    string | number | boolean | string[]
  >;
  const query: Record<string, string | number | boolean | string[]> =
    section.dataSource === 'LIVE_OFFERS'
      ? { ...saved, sort: 'discount', inStock: true }
      : { ...saved };
  const atDepot = query.inStock === true && nodeId !== null;
  if (atDepot) query.nodeId = nodeId;
  query.limit = limit;
  if (cursor !== undefined) query.cursor = cursor;
  return { query, atDepot };
};

/**
 * Public home: the live layout snapshot (in-process 5 s → Redis 30 s → DB), filtered per request
 * in memory, plus the data behind it (banners, root categories, product rails) with short caches,
 * stale fallbacks and timeouts so one slow service never blanks the page.
 */
export class HomeService {
  private readonly local = new LocalCache<CompiledSnapshot | 'none'>(4, LOCAL_TTL_MS);
  /** Last snapshot that loaded fine, per page: served when Postgres and Redis are both down. */
  private readonly lastGood = new Map<HomePage, CompiledSnapshot>();
  /** Hot copies of catalog data and product pages (per instance, 5 s). */
  private readonly hot = new LocalCache<unknown>(500, LOCAL_TTL_MS);

  constructor(private readonly deps: Deps) {}

  // ── Snapshot ──

  async compiled(page: HomePage): Promise<{ compiled: CompiledSnapshot | null; stale: boolean }> {
    const hit = this.local.get(page);
    if (hit !== undefined) return { compiled: hit === 'none' ? null : hit, stale: false };
    try {
      const snap = await this.loadSnapshot(page);
      const compiled = snap === null ? null : compileSnapshot(snap);
      this.local.set(page, compiled ?? 'none');
      if (compiled !== null) this.lastGood.set(page, compiled);
      return { compiled, stale: false };
    } catch (err) {
      const last = this.lastGood.get(page);
      if (last === undefined) {
        this.deps.logger.error({ err, page }, 'home layout unavailable');
        throw new ServiceUnavailableError('Home layout unavailable');
      }
      this.deps.logger.warn({ err, page }, 'home layout served from last good copy');
      return { compiled: last, stale: true };
    }
  }

  private async loadSnapshot(page: HomePage): Promise<Snapshot | null> {
    const key = userKeys.homeLayout(page);
    let cached: CachedLayout | undefined;
    try {
      cached = await this.deps.cache.get<CachedLayout>(key);
    } catch (err) {
      this.deps.logger.warn({ err }, 'home layout cache unavailable');
    }
    const now = Date.now();
    if (cached !== undefined && (cached.nextScheduledAt === null || cached.nextScheduledAt > now))
      return cached.snap;

    await this.promoteDueSchedule(page);
    const repo = this.deps.homeRepository;
    const [tree, scheduled] = await Promise.all([repo.live(page), repo.scheduled(page)]);
    const nextScheduledAt = scheduled?.scheduledPublishAt?.getTime() ?? null;
    const snap = tree === null ? null : toSnapshot(tree, scheduled?.scheduledPublishAt ?? null);
    const ttl =
      nextScheduledAt === null
        ? LAYOUT_TTL_SECONDS
        : Math.max(1, Math.min(LAYOUT_TTL_SECONDS, Math.ceil((nextScheduledAt - now) / 1000)));
    await this.deps.cache
      .set<CachedLayout>(key, { snap, nextScheduledAt }, ttl)
      .catch((err: unknown) => {
        this.deps.logger.warn({ err }, 'home layout cache write failed');
      });
    return snap;
  }

  /** A SCHEDULED layout whose time has come goes live (lazy: first read after its time). */
  private async promoteDueSchedule(page: HomePage): Promise<void> {
    const repo = this.deps.homeRepository;
    const due = await repo.scheduled(page);
    const at = due?.scheduledPublishAt?.getTime();
    if (due === null || at === undefined || at > Date.now()) return;
    const promoted = await this.deps.runInTransaction(async (tx) => {
      await repo.lockPage(tx, page);
      const again = await repo.scheduled(page, tx);
      if (again?.id !== due.id) return false; // another instance flipped it
      await this.makeLive(tx, again, SYSTEM_ACTOR, 'home_layout.publish_scheduled', null, {
        status: 'SCHEDULED',
      });
      return true;
    });
    if (promoted) {
      this.deps.logger.info({ page, layoutId: due.id }, 'scheduled home layout is live');
      this.local.delete(page);
    }
  }

  /**
   * Inside the caller's transaction (page lock held): archive the current live layout, make
   * `layout` live with the next publishRev, audit. Shared by publish, rollback and the scheduler.
   */
  async makeLive(
    tx: Tx,
    layout: LayoutRow,
    actor: Actor,
    action: string,
    reason: string | null,
    guard: { version?: number; status?: LayoutStatus },
  ): Promise<number> {
    const repo = this.deps.homeRepository;
    const current = await repo.published(tx, layout.page);
    if (current !== null && current.id !== layout.id)
      await repo.update(
        tx,
        current.id,
        { status: 'PUBLISHED' },
        { status: 'ARCHIVED', updatedByUserId: actor.userId },
      );
    const publishRev = await repo.nextPublishRev(tx, layout.page);
    const ok = await repo.update(tx, layout.id, guard, {
      status: 'PUBLISHED',
      publishRev,
      publishedAt: new Date(),
      publishedByUserId:
        actor === SYSTEM_ACTOR ? (layout.publishedByUserId ?? actor.userId) : actor.userId,
      scheduledPublishAt: null,
      updatedByUserId: actor.userId,
    });
    if (!ok)
      throw new ConflictError('The layout was changed by someone else; reload and retry', {
        details: { reason: 'HOME_LAYOUT_VERSION_CONFLICT' },
      });
    await this.deps.auditService.record(tx, actor, {
      action,
      targetType: 'home_layout',
      targetId: layout.id,
      before: { status: layout.status, publishRev: layout.publishRev },
      after: { status: 'PUBLISHED', publishRev, archivedLayoutId: current?.id ?? null },
      reason,
    });
    return publishRev;
  }

  /** After a publish / rollback / ref-check commit: drop this instance's and Redis's copy. */
  async invalidate(page: HomePage): Promise<void> {
    this.local.delete(page);
    await this.deps.cache.invalidate(userKeys.homeLayout(page)).catch((err: unknown) => {
      this.deps.logger.warn({ err }, 'home layout cache invalidation failed');
    });
  }

  // ── Public reads ──

  async layout(page: HomePage, ctx: HomeContext): Promise<{ view: LayoutView; meta: HomeMeta }> {
    const started = performance.now();
    const meta = this.newMeta(ctx);
    const { compiled, stale } = await this.compiled(page);
    if (stale) meta.stale.push('layout');
    if (compiled === null)
      return {
        view: {
          schemaVersion: SCHEMA_VERSION,
          page,
          layoutNo: null,
          publishRev: null,
          sections: [],
        },
        meta,
      };
    const sections = await this.assemble(compiled, ctx, meta, { cache: true });
    meta.timings = { ...meta.timings, total: Math.round(performance.now() - started) };
    return {
      view: {
        schemaVersion: SCHEMA_VERSION,
        page,
        layoutNo: compiled.snap.layoutNo,
        publishRev: compiled.snap.publishRev,
        sections,
      },
      meta,
    };
  }

  /** Next pages of one product section (cursor), for the caller as the layout targeted them. */
  async sectionPage(
    page: HomePage,
    sectionKey: string,
    ctx: HomeContext,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ data: ProductPage & { key: string }; meta: HomeMeta }> {
    const meta = this.newMeta(ctx);
    const { compiled, stale } = await this.compiled(page);
    if (stale) meta.stale.push('layout');
    const facts = factsOf(ctx);
    const section =
      compiled === null
        ? undefined
        : visibleSections(compiled, facts, ctx.sdui).find((s) => s.row.sectionKey === sectionKey);
    if (compiled === null || section === undefined)
      throw new NotFoundError('Home section', { details: { reason: 'HOME_SECTION_NOT_FOUND' } });
    if (!isProductSource(section.row))
      throw new ValidationError(
        [{ path: 'params.sectionKey', message: 'this section has no product pages' }],
        'Not a product section',
      );
    const result = await this.productPage(compiled.snap, section, ctx, facts, cursor, limit, meta, {
      cache: true,
    });
    return { data: { key: sectionKey, ...(result ?? { items: [], nextCursor: null }) }, meta };
  }

  /** First page of several product sections at once (lower rails, one round trip). */
  async sectionsBatch(
    page: HomePage,
    keys: readonly string[],
    ctx: HomeContext,
  ): Promise<{
    data: { key: string; status: 'OK' | 'NOT_FOUND' | 'DEGRADED'; data: ProductPage | null }[];
    meta: HomeMeta;
  }> {
    const meta = this.newMeta(ctx);
    const { compiled, stale } = await this.compiled(page);
    if (stale) meta.stale.push('layout');
    const facts = factsOf(ctx);
    const visible = compiled === null ? [] : visibleSections(compiled, facts, ctx.sdui);
    const unique = [...new Set(keys)].slice(0, LIMITS.batchKeys);
    const data = await Promise.all(
      unique.map(async (key) => {
        const section = visible.find((s) => s.row.sectionKey === key && isProductSource(s.row));
        if (compiled === null || section === undefined)
          return { key, status: 'NOT_FOUND' as const, data: null };
        const result = await this.productPage(
          compiled.snap,
          section,
          ctx,
          facts,
          undefined,
          section.row.itemLimit,
          meta,
          { cache: true },
        );
        return result === null
          ? { key, status: 'DEGRADED' as const, data: null }
          : { key, status: 'OK' as const, data: result };
      }),
    );
    return { data, meta };
  }

  /** Admin preview: same assembly on any layout (draft too), no caches. */
  async preview(tree: LayoutTree, ctx: HomeContext): Promise<{ view: LayoutView; meta: HomeMeta }> {
    const meta = this.newMeta(ctx);
    const compiled = compileSnapshot(toSnapshot(tree, null));
    const sections = await this.assemble(compiled, ctx, meta, { cache: false });
    return {
      view: {
        schemaVersion: SCHEMA_VERSION,
        page: tree.page,
        layoutNo: tree.layoutNo,
        publishRev: tree.publishRev,
        sections,
      },
      meta,
    };
  }

  private newMeta(ctx: HomeContext): HomeMeta {
    return {
      authState: ctx.authState,
      region: ctx.region,
      degraded: [],
      stale: [],
      ttlSeconds: LAYOUT_TTL_SECONDS,
      timings: {},
    };
  }

  // ── Assembly ──

  private async assemble(
    compiled: CompiledSnapshot,
    ctx: HomeContext,
    meta: HomeMeta,
    opts: AssembleOptions,
  ): Promise<SectionView[]> {
    const facts = factsOf(ctx);
    const visible = visibleSections(compiled, facts, ctx.sdui);
    const inline = new Set(
      visible
        .filter((s) => s.row.inline && isProductSource(s.row))
        .slice(0, LIMITS.inline)
        .map((s) => s.row.sectionKey),
    );
    const deadline = Date.now() + INLINE_BUDGET_MS;
    const views = await Promise.all(
      visible.map((s, i) =>
        this.sectionView(compiled.snap, s, i + 1, ctx, facts, meta, {
          ...opts,
          inline: inline.has(s.row.sectionKey),
          deadline,
        }),
      ),
    );
    return views.filter((v): v is SectionView => v !== null);
  }

  private async sectionView(
    snap: Snapshot,
    section: CompiledSection,
    order: number,
    ctx: HomeContext,
    facts: RuleFacts,
    meta: HomeMeta,
    opts: AssembleOptions & { inline: boolean; deadline: number },
  ): Promise<SectionView | null> {
    const row = section.row;
    const bucket = bucketFor(section, facts);
    const base: SectionView = {
      key: row.sectionKey,
      widget: row.widgetType,
      dataSource: row.dataSource,
      order,
      eyebrow: localize(row.eyebrow, ctx.lang),
      title: localize(row.title, ctx.lang),
      subtitle: localize(row.subtitle, ctx.lang),
      viewAllLink: row.viewAllLink,
      minItems: row.minItems,
      config: localizeDeep(row.config, ctx.lang) as Record<string, unknown>,
      tracking: {
        id: trackingId(snap.page, snap.layoutNo, row.sectionKey),
        ...(row.experimentKey !== null && { experimentKey: row.experimentKey }),
        ...(bucket !== undefined && { bucket }),
      },
    };
    if (row.feedKey !== null) {
      const feed = this.feedRef(row.feedKey);
      const hide = row.config.fallback !== 'PLACEHOLDER';
      // A feed with no backend yet, or one a guest can't read, hides a pure feed widget.
      const unusable = !feed.available || (feed.requiresLogin && ctx.userType === 'guest');
      if (unusable && hide && row.dataSource === 'REMOTE_FEED') return null;
      base.feed = feed;
    }

    switch (row.dataSource) {
      case 'STATIC_ITEMS': {
        const items = this.items(snap, section, facts, ctx);
        const hidden = !PROMO_WIDGETS.has(row.widgetType) && items.length < row.minItems;
        return hidden ? null : { ...base, items };
      }
      case 'CATALOG_CATEGORIES': {
        const roots = await this.categories(meta, row.sectionKey, opts.cache);
        if (roots === null) return null;
        const items = roots.slice(0, row.itemLimit).map((c): ItemView => ({
          id: c.id,
          refType: 'CATEGORY',
          refId: c.id,
          refCode: null,
          label: c.name,
          subtitle: null,
          badge: null,
          image: imageView(c.imageUrl === null ? null : { url: c.imageUrl }),
          deepLink: `farmx://category/${c.slug}`,
          tracking: { id: trackingId(snap.page, snap.layoutNo, row.sectionKey, c.id) },
        }));
        return items.length < row.minItems ? null : { ...base, items };
      }
      case 'BANNER_PLACEMENT': {
        const code = typeof row.config.placementCode === 'string' ? row.config.placementCode : '';
        const placement = await this.placement(code, meta, row.sectionKey, opts.cache);
        if (placement === null) return null;
        const banners = placement.banners.slice(0, Math.min(row.itemLimit, placement.maxItems));
        return banners.length < row.minItems
          ? null
          : { ...base, banners, aspectRatio: placement.aspectRatio };
      }
      case 'REMOTE_FEED':
        return base;
      case 'MANUAL_PRODUCTS':
      case 'DYNAMIC_QUERY':
      case 'LIVE_OFFERS': {
        const view: SectionView = {
          ...base,
          fetch: {
            endpoint: `/v1/home/sections/${row.sectionKey}?page=${snap.page}`,
            limit: row.itemLimit,
          },
        };
        if (!opts.inline) return view;
        const data = await before(
          this.productPage(snap, section, ctx, facts, undefined, row.itemLimit, meta, opts),
          opts.deadline,
        );
        if (data === undefined || data === null) return view; // late or down: the app fetches it
        return data.items.length < row.minItems ? null : { ...view, data };
      }
    }
  }

  private items(
    snap: Snapshot,
    section: CompiledSection,
    facts: RuleFacts,
    ctx: HomeContext,
  ): ItemView[] {
    return section.items
      .filter((i) => i.row.isEnabled && !i.row.refBroken && matches(i.rule, facts))
      .slice(0, section.row.itemLimit)
      .map(({ row: item }) => this.itemView(snap, section.row.sectionKey, item, ctx));
  }

  private itemView(snap: Snapshot, sectionKey: string, item: ItemRow, ctx: HomeContext): ItemView {
    return {
      id: item.id,
      refType: item.refType,
      refId: item.refId,
      refCode: item.refCode,
      label: localize(item.label, ctx.lang) ?? item.label.en,
      subtitle: localize(item.subtitle, ctx.lang),
      badge: localize(item.badge, ctx.lang),
      image: imageView(item.image),
      deepLink: item.deepLink,
      tracking: { id: trackingId(snap.page, snap.layoutNo, sectionKey, item.id) },
    };
  }

  private feedRef(key: FeedKey): NonNullable<SectionView['feed']> {
    const def = FEED_DEFS[key];
    return {
      key,
      endpoint: `/v1/home/feeds?keys=${key}`,
      requiresLogin: def.requiresLogin,
      available: def.available,
    };
  }

  // ── Data behind sections ──

  /**
   * One page of a product section: cards from product-service (the catalog listing's own card),
   * decorated per caller. MANUAL lists page by offset over the admin's ids; DYNAMIC / LIVE pass
   * the saved query (+ the caller's depot when it filters on stock) and product-service's cursor.
   * null = product-service down and no stale copy (the rail hides).
   */
  private async productPage(
    snap: Snapshot,
    section: CompiledSection,
    ctx: HomeContext,
    facts: RuleFacts,
    cursor: string | undefined,
    limit: number,
    meta: HomeMeta,
    opts: AssembleOptions,
  ): Promise<ProductPage | null> {
    const row = section.row;
    const started = performance.now();
    const raw =
      row.dataSource === 'MANUAL_PRODUCTS'
        ? await this.manualPage(section, facts, cursor, limit, meta)
        : await this.queryPage(snap, row, ctx, cursor, limit, meta, opts);
    meta.timings = {
      ...meta.timings,
      [row.sectionKey]: Math.round(performance.now() - started),
    };
    if (raw === null) return null;
    const tel = phoneFor(snap, ctx.region);
    const ids = { page: snap.page, layoutNo: snap.layoutNo, sectionKey: row.sectionKey };
    return {
      items: raw.items.map((card) => decorateCard(card, ids, tel, raw.inStockAtDepot)),
      nextCursor: raw.nextCursor,
    };
  }

  private async manualPage(
    section: CompiledSection,
    facts: RuleFacts,
    cursor: string | undefined,
    limit: number,
    meta: HomeMeta,
  ): Promise<RawProductPage | null> {
    const ids = section.items.flatMap((i) =>
      i.row.isEnabled && !i.row.refBroken && i.row.refId !== null && matches(i.rule, facts)
        ? [i.row.refId]
        : [],
    );
    const offset = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
    const pageIds = ids.slice(offset, offset + limit);
    let cards: Map<string, ProductCard>;
    try {
      // product cards are Redis-cached per product (120 s) inside ProductClient.
      cards = await this.deps.productClient.cards(pageIds, PRODUCT_TIMEOUT_MS);
    } catch (err) {
      this.deps.logger.warn({ err, section: section.row.sectionKey }, 'home: product cards down');
      meta.degraded.push(section.row.sectionKey);
      return null;
    }
    const items = pageIds
      .map((id) => cards.get(id))
      .filter((c): c is ProductCard => c?.available === true);
    const next = offset + limit;
    return { items, nextCursor: next < ids.length ? String(next) : null, inStockAtDepot: null };
  }

  private async queryPage(
    snap: Snapshot,
    row: SectionRow,
    ctx: HomeContext,
    cursor: string | undefined,
    limit: number,
    meta: HomeMeta,
    opts: AssembleOptions,
  ): Promise<RawProductPage | null> {
    const { query, atDepot } = productQuery(row, ctx.nodeId, cursor, limit);
    const fetch = async (): Promise<RawProductPage> => {
      const page = await this.deps.productClient.list(query, PRODUCT_TIMEOUT_MS);
      return { ...page, inStockAtDepot: atDepot ? true : null };
    };
    if (!opts.cache) {
      try {
        return await fetch();
      } catch (err) {
        this.deps.logger.warn({ err, section: row.sectionKey }, 'home preview: product list down');
        meta.degraded.push(row.sectionKey);
        return null;
      }
    }
    const node = atDepot && ctx.nodeId !== null ? ctx.nodeId : '-';
    const args = [
      snap.page,
      snap.publishRev,
      row.sectionKey,
      node,
      cursorKey(cursor),
      limit,
    ] as const;
    const got = await this.remember(
      userKeys.homeSection(...args),
      userKeys.homeSection(...args, true),
      fetch,
    );
    if (got === null) {
      meta.degraded.push(row.sectionKey);
      return null;
    }
    if (got.stale) meta.stale.push(row.sectionKey);
    return got.value;
  }

  private async categories(
    meta: HomeMeta,
    label: string,
    cache: boolean,
  ): Promise<CatalogCategory[] | null> {
    const fetch = () => this.deps.catalogClient.categories(CATALOG_TIMEOUT_MS);
    const got = cache
      ? await this.remember(
          userKeys.homeCatalog('categories', 'roots'),
          userKeys.homeCatalog('categories', 'roots', true),
          fetch,
        )
      : await fetch().then(
          (value) => ({ value, stale: false }),
          () => null,
        );
    if (got === null) {
      meta.degraded.push(label);
      return null;
    }
    if (got.stale) meta.stale.push(label);
    return got.value;
  }

  private async placement(
    code: string,
    meta: HomeMeta,
    label: string,
    cache: boolean,
  ): Promise<CatalogPlacement | null> {
    const fetch = () => this.deps.catalogClient.placement(code, CATALOG_TIMEOUT_MS);
    const got = cache
      ? await this.remember(
          userKeys.homeCatalog('banner', code),
          userKeys.homeCatalog('banner', code, true),
          fetch,
        )
      : await fetch().then(
          (value) => ({ value, stale: false }),
          () => null,
        );
    if (got === null) {
      meta.degraded.push(label);
      return null;
    }
    if (got.stale) meta.stale.push(label);
    return got.value; // null value = placement gone: the section simply hides
  }

  /**
   * Read-through with a fallback: hot in-process copy (5 s) → Redis (60 s) → `fetch` (written
   * to both the fresh key and a 10-min stale key) → on failure the stale key. null = nothing.
   * Also used by the Categories page (`HomeCategoriesService`).
   */
  async remember<T>(
    key: string,
    staleKey: string,
    fetch: () => Promise<T>,
  ): Promise<Remembered<T> | null> {
    const hot = this.hot.get(key) as { v: T } | undefined;
    if (hot !== undefined) return { value: hot.v, stale: false };
    const cache = this.deps.cache;
    try {
      const fresh = await cache.get<{ v: T }>(key);
      if (fresh !== undefined) {
        this.hot.set(key, fresh);
        return { value: fresh.v, stale: false };
      }
    } catch {
      // Redis down: go to the source.
    }
    try {
      const value = await fetch();
      const wrapped = { v: value };
      this.hot.set(key, wrapped);
      await Promise.all([
        cache.set(key, wrapped, DATA_TTL_SECONDS),
        cache.set(staleKey, wrapped, STALE_TTL_SECONDS),
      ]).catch(() => undefined);
      return { value, stale: false };
    } catch (err) {
      this.deps.logger.warn({ err, key }, 'home: upstream unavailable; trying stale copy');
      const old = await cache.get<{ v: T }>(staleKey).catch(() => undefined);
      return old === undefined ? null : { value: old.v, stale: true };
    }
  }
}
