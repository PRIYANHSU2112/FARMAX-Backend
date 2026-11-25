import Joi from 'joi';

import type { DataSource, FeedKey, RefType, SectionInput, WidgetType } from './home.types.js';
import { CODE, ID, IMAGE, L, LINK } from './home.validation.js';

/**
 * One entry per widget: the `X-SDUI-Version` that introduced it (older apps never receive it),
 * the data sources and feed keys it accepts, the item kinds it holds and its `config` schema.
 * Adding a widget = add it here with `since: <next version>`; old apps keep working.
 */
interface WidgetSpec {
  since: number;
  sources: readonly DataSource[];
  /** REMOTE_FEED needs one of these; other sources may name one for live fields. */
  feedKeys: readonly FeedKey[];
  /** Item kinds for STATIC_ITEMS (MANUAL_PRODUCTS always takes PRODUCT items). */
  refTypes: readonly RefType[];
  config: Joi.ObjectSchema;
}

const FALLBACK = Joi.string().valid('HIDE', 'PLACEHOLDER').default('HIDE');
const CTA = Joi.object({ label: L(30).required(), deepLink: LINK.required() });
const SLUG = Joi.string()
  .lowercase()
  .pattern(/^[a-z0-9-]{1,100}$/);

/** Saved product-service list filter (same names as `GET /v1/catalog/products`). */
export const PRODUCT_QUERY = Joi.object({
  categorySlug: SLUG,
  brandId: Joi.array().items(ID).unique().max(20),
  species: Joi.array().items(CODE).unique().max(10),
  flockStage: Joi.array().items(CODE).unique().max(10),
  diseaseSlug: Joi.array().items(SLUG).unique().max(10),
  isFeatured: Joi.boolean(),
  isPrescriptionRequired: Joi.boolean(),
  temperatureClass: Joi.string().valid('AMB', 'AMB_CTL', 'CC_REF', 'CC_FRZ', 'HAZ'),
  inStock: Joi.boolean(),
  minRating: Joi.number().integer().min(1).max(5),
  sort: Joi.string().valid(
    'relevance',
    'name',
    'price_asc',
    'price_desc',
    'discount',
    'newest',
    'rating',
    'shelf_life',
  ),
});

const PRODUCTS = Joi.object({
  query: PRODUCT_QUERY,
  badge: L(30),
  background: IMAGE,
  /** Flash-deal countdown end (ISO). */
  endsAt: Joi.string().isoDate(),
  fallback: FALLBACK,
});

const PROMO = Joi.object({
  badge: L(30),
  /** e.g. "from ₹199". */
  priceChip: L(30),
  /** Static line, e.g. "Average response: 18 minutes". */
  note: L(80),
  image: IMAGE,
  cta: CTA,
  secondaryCta: CTA,
  fallback: FALLBACK,
});

const FEED_ONLY = Joi.object({
  limit: Joi.number().integer().min(1).max(10),
  cta: CTA,
  fallback: FALLBACK,
});

const GRID = Joi.object({
  columns: Joi.number().integer().min(2).max(5),
  style: Joi.string().valid('GRID', 'CIRCLES'),
  fallback: FALLBACK,
});

export const WIDGET_SPECS: Readonly<Record<WidgetType, WidgetSpec>> = {
  BANNER_CAROUSEL: {
    since: 1,
    sources: ['BANNER_PLACEMENT'],
    feedKeys: [],
    refTypes: [],
    config: Joi.object({
      placementCode: Joi.string()
        .trim()
        .uppercase()
        .pattern(/^[A-Z][A-Z0-9_]{1,59}$/)
        .required(),
      autoplayMs: Joi.number().integer().min(2000).max(15_000),
      fallback: FALLBACK,
    }),
  },
  CATEGORY_GRID: {
    since: 1,
    sources: ['STATIC_ITEMS', 'CATALOG_CATEGORIES'],
    feedKeys: [],
    refTypes: ['CATEGORY', 'CUSTOM'],
    config: Joi.object({
      style: Joi.string().valid('GRID_4', 'LIST_CARD').default('GRID_4'),
      columns: Joi.number().integer().min(2).max(5),
      fallback: FALLBACK,
    }),
  },
  PRODUCT_GRID_2X2: {
    since: 1,
    sources: ['MANUAL_PRODUCTS', 'DYNAMIC_QUERY', 'LIVE_OFFERS'],
    feedKeys: [],
    refTypes: ['PRODUCT'],
    config: PRODUCTS,
  },
  PRODUCT_HORIZONTAL_RAIL: {
    since: 1,
    sources: ['MANUAL_PRODUCTS', 'DYNAMIC_QUERY', 'LIVE_OFFERS'],
    feedKeys: [],
    refTypes: ['PRODUCT'],
    config: PRODUCTS,
  },
  VET_CONSULT_PROMO: {
    since: 1,
    sources: ['STATIC_ITEMS'],
    feedKeys: ['VET_AVAILABILITY'],
    refTypes: ['CUSTOM'],
    config: PROMO,
  },
  BULK_FEED_PROMO: {
    since: 1,
    sources: ['STATIC_ITEMS'],
    feedKeys: [],
    refTypes: ['CUSTOM'],
    config: PROMO,
  },
  REORDER_CARD: {
    since: 1,
    sources: ['REMOTE_FEED'],
    feedKeys: ['BUY_AGAIN'],
    refTypes: [],
    config: FEED_ONLY,
  },
  FLOCK_STAGE_SELECTOR: {
    since: 1,
    sources: ['STATIC_ITEMS'],
    feedKeys: ['FLOCK_CONTEXT'],
    refTypes: ['FLOCK_STAGE', 'CUSTOM'],
    config: Joi.object({
      style: Joi.string().valid('CHIPS', 'CARDS').default('CARDS'),
      fallback: FALLBACK,
    }),
  },
  NEWS_FEED: {
    since: 1,
    sources: ['REMOTE_FEED'],
    feedKeys: ['NEWS_LATEST'],
    refTypes: [],
    config: FEED_ONLY,
  },
  LIVE_ORDER_STRIP: {
    since: 1,
    sources: ['REMOTE_FEED'],
    feedKeys: ['ORDER_LIVE'],
    refTypes: [],
    config: FEED_ONLY,
  },
  REQUIREMENT_CALENDAR: {
    since: 1,
    sources: ['REMOTE_FEED'],
    feedKeys: ['REQUIREMENT_DUE'],
    refTypes: [],
    config: FEED_ONLY,
  },
  APPOINTMENT_CARD: {
    since: 1,
    sources: ['REMOTE_FEED'],
    feedKeys: ['APPOINTMENT_NEXT'],
    refTypes: [],
    config: FEED_ONLY,
  },
  SHOP_BY_PROBLEM: {
    since: 1,
    sources: ['STATIC_ITEMS'],
    feedKeys: [],
    refTypes: ['DISEASE', 'CUSTOM'],
    config: GRID,
  },
  BRAND_GRID: {
    since: 1,
    sources: ['STATIC_ITEMS'],
    feedKeys: [],
    refTypes: ['BRAND', 'CUSTOM'],
    config: GRID,
  },
};

/** Promo cards are content, not lists: `minItems` never hides them (items are optional extras). */
export const PROMO_WIDGETS: ReadonlySet<WidgetType> = new Set([
  'VET_CONSULT_PROMO',
  'BULK_FEED_PROMO',
]);

/** The app can render this widget (`X-SDUI-Version` ≥ the version that introduced it). */
export const supportedBy = (widget: WidgetType, sdui: number): boolean =>
  WIDGET_SPECS[widget].since <= sdui;

export interface Issue {
  path: string;
  message: string;
}

/**
 * Cross-field rules Joi can't express per section: widget ↔ source ↔ feed key, per-widget
 * config, allowed item kinds. Returns the issues and the config with defaults applied.
 */
export function checkSection(
  section: SectionInput,
  index: number,
): { issues: Issue[]; config: Record<string, unknown> } {
  const at = `body.sections.${String(index)}`;
  const spec = WIDGET_SPECS[section.widgetType];
  const issues: Issue[] = [];

  if (!spec.sources.includes(section.dataSource))
    issues.push({
      path: `${at}.dataSource`,
      message: `${section.widgetType} takes ${spec.sources.join(' | ')}`,
    });

  if (section.dataSource === 'REMOTE_FEED' && section.feedKey === null)
    issues.push({ path: `${at}.feedKey`, message: 'REMOTE_FEED needs a feedKey' });
  if (section.feedKey !== null && !spec.feedKeys.includes(section.feedKey))
    issues.push({
      path: `${at}.feedKey`,
      message:
        spec.feedKeys.length === 0
          ? `${section.widgetType} takes no feedKey`
          : `${section.widgetType} takes ${spec.feedKeys.join(' | ')}`,
    });

  const result = spec.config.validate(section.config, { abortEarly: false, convert: true });
  for (const detail of result.error?.details ?? [])
    issues.push({ path: `${at}.config.${detail.path.join('.')}`, message: detail.message });
  const config = (result.value as Record<string, unknown> | undefined) ?? {};
  if (section.dataSource === 'DYNAMIC_QUERY' && config.query === undefined)
    issues.push({ path: `${at}.config.query`, message: 'DYNAMIC_QUERY needs config.query' });

  const takesItems =
    section.dataSource === 'STATIC_ITEMS' || section.dataSource === 'MANUAL_PRODUCTS';
  if (!takesItems && section.items.length > 0)
    issues.push({ path: `${at}.items`, message: `${section.dataSource} sections hold no items` });
  if (section.dataSource === 'MANUAL_PRODUCTS' && section.items.length === 0)
    issues.push({ path: `${at}.items`, message: 'MANUAL_PRODUCTS needs at least one product' });
  const allowed: readonly RefType[] =
    section.dataSource === 'MANUAL_PRODUCTS' ? ['PRODUCT'] : spec.refTypes;
  section.items.forEach((item, i) => {
    if (takesItems && !allowed.includes(item.refType))
      issues.push({
        path: `${at}.items.${String(i)}.refType`,
        message: `${section.widgetType} items take ${allowed.join(' | ') || 'nothing'}`,
      });
  });
  return { issues, config };
}
