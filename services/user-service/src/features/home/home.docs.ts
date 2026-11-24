import type { DocHeader, RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { IDS, ok } from '../../docs/shared.js';
import {
  DATA_SOURCES,
  FEED_KEYS,
  LAYOUT_STATUSES,
  PAGES,
  REF_TYPES,
  WIDGETS,
  type WidgetType,
} from './home.types.js';

export const HOME_TAG = 'Home (server-driven UI)';
export const ADMIN_HOME_TAG = 'Admin · Home layouts';

const LAYOUT_RATE = '120 per user (or IP) per minute';
const SECTIONS_RATE = '60 per user (or IP) per minute';
const FEEDS_RATE = '30 per user (or IP) per minute';
const AUTH_OPTIONAL =
  'Optional. No token = guest. A valid `CUSTOMER` token = farmer (region and depot come from the farmer’s own farm). An invalid or expired token is **never** a 401 here: the caller is served as a guest and `meta.authState` is `expired`, so the app can refresh quietly.';
const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) **and** the permission below.';

// ── Headers ──

const H = (description: string, schema?: Record<string, unknown>): DocHeader => ({
  description,
  ...(schema && { schema }),
});

const CLIENT_HEADERS: Record<string, DocHeader> = {
  'X-Platform': H('`android` | `ios` | `web` (platform targeting).', {
    type: 'string',
    enum: ['android', 'ios', 'web'],
  }),
  'X-App-Version': H('App version, e.g. `1.4.0` (minAppVersion targeting).'),
  'X-SDUI-Version': H(
    'Widget-set version the app can render (integer, default 1). Widgets added in a later version are left out, so old apps never get a widget they cannot draw.',
    { type: 'integer', minimum: 1, example: 1 },
  ),
  'X-Device-Id': H(
    'Stable install id, 8–64 chars `[A-Za-z0-9._-]`. Seeds the A/B bucket (stays the same across login).',
  ),
  'X-Farm-Id': H(
    'Farmer with several farms: the farm that decides region + depot. Must be one of the caller’s ACTIVE farms (otherwise ignored → the oldest ACTIVE farm).',
  ),
  'Accept-Language': H('`hi` → Hindi text where filled; anything else → English.'),
  'If-None-Match': H('ETag of the previous response → 304 when nothing changed for this caller.'),
};

const IF_MATCH: Record<string, DocHeader> = {
  'If-Match': {
    description: 'Required. The layout `version` you loaded (from `ETag`). Stale → 409.',
    required: true,
    schema: { type: 'string', example: '"3"' },
  },
};

const ETAG_OUT: Record<string, DocHeader> = {
  ETag: { description: 'Weak ETag of this caller’s response (send back as `If-None-Match`).' },
  'Cache-Control': { description: '`private, no-cache`' },
};

// ── Public schemas ──

const tracking = Joi.object({
  id: Joi.string().example('HOME:12:featured'),
  experimentKey: Joi.string(),
  bucket: Joi.number().integer().min(0).max(99),
}).meta({ className: 'HomeTracking' });

const image = Joi.object({
  mediaId: Joi.string().guid(),
  url: Joi.string().uri(),
  width: Joi.number().integer(),
  height: Joi.number().integer(),
  aspectRatio: Joi.number().allow(null).description('width / height, so the layout does not jump'),
  variants: Joi.any().valid(null).description('⏳ Future: CDN width variants'),
  blurHash: Joi.any().valid(null).description('⏳ Future: blur placeholder'),
}).meta({ className: 'HomeImage' });

const item = Joi.object({
  id: Joi.string().guid(),
  refType: Joi.string().valid(...REF_TYPES),
  refId: Joi.string().guid().allow(null),
  refCode: Joi.string().allow(null),
  label: Joi.string(),
  subtitle: Joi.string().allow(null),
  badge: Joi.string().allow(null),
  image: image.allow(null),
  deepLink: Joi.string(),
  tracking,
}).meta({ className: 'HomeItem' });

const productCard = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string(),
  slug: Joi.string(),
  isPrescriptionRequired: Joi.boolean().description('Rx badge'),
  temperatureClass: Joi.string().description('CC_REF = 2–8 °C badge'),
  isColdChain: Joi.boolean(),
  imageUrl: Joi.string().allow(null),
  defaultVariant: Joi.object({
    packSize: Joi.string().description('"Doses · 1000" = packUnit.name + packSize'),
    packUnit: Joi.object({ code: Joi.string(), name: Joi.string() }).unknown(true),
    mrp: Joi.string(),
    sellingPrice: Joi.string().allow(null),
    discountPercent: Joi.number().allow(null),
  })
    .unknown(true)
    .allow(null),
  inStock: Joi.boolean(),
  tracking,
  actions: Joi.object({
    primary: Joi.string().valid('ADD_TO_CART', 'UPLOAD_RX'),
    uploadRxLink: Joi.string().allow(null),
    call: Joi.object({ type: Joi.string().valid('PHONE_ORDER'), tel: Joi.string() }).allow(null),
  }),
  priceBreak: Joi.any().description('"₹306 at 50+". ⏳ Future: null until product-service adds it'),
  inStockAtDepot: Joi.boolean().allow(null),
})
  .unknown(true)
  .description(
    'The catalog listing’s own product-service card (all fields passed through) + `tracking`, `actions`, `priceBreak`, `inStockAtDepot`. Wishlist hearts: `GET /v1/me/wishlist/ids`.',
  )
  .meta({ className: 'HomeProductCard' });

const productPage = Joi.object({
  items: Joi.array().items(productCard),
  nextCursor: Joi.string().allow(null),
}).meta({ className: 'HomeProductPage' });

const feedRef = Joi.object({
  key: Joi.string().valid(...FEED_KEYS),
  endpoint: Joi.string().example('/v1/home/feeds?keys=ORDER_LIVE'),
  requiresLogin: Joi.boolean(),
  available: Joi.boolean().description('false = ⏳ Future (no backend yet)'),
}).meta({ className: 'HomeFeedRef' });

const COMMON = {
  key: Joi.string().example('featured'),
  dataSource: Joi.string().valid(...DATA_SOURCES),
  order: Joi.number().integer(),
  eyebrow: Joi.string().allow(null),
  title: Joi.string().allow(null),
  subtitle: Joi.string().allow(null),
  viewAllLink: Joi.string().allow(null),
  minItems: Joi.number().integer(),
  config: Joi.object().unknown(true).description('Per-widget settings (text already localized)'),
  tracking,
};

const pascal = (w: string) =>
  w
    .toLowerCase()
    .split('_')
    .map((p) => (p === '2x2' ? '2x2' : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
const className = (w: WidgetType) => `HomeSection${pascal(w)}`;

const ITEMS = { items: Joi.array().items(item) };
const PRODUCTS = {
  fetch: Joi.object({ endpoint: Joi.string(), limit: Joi.number().integer() }),
  data: productPage.description('First page, present for `inline` sections'),
};
const FEED = { feed: feedRef };
const EXTRA: Record<WidgetType, Joi.PartialSchemaMap> = {
  BANNER_CAROUSEL: {
    banners: Joi.array().items(Joi.object().unknown(true)),
    aspectRatio: Joi.string().allow(null),
  },
  CATEGORY_GRID: ITEMS,
  PRODUCT_GRID_2X2: PRODUCTS,
  PRODUCT_HORIZONTAL_RAIL: PRODUCTS,
  VET_CONSULT_PROMO: { ...ITEMS, ...FEED },
  BULK_FEED_PROMO: ITEMS,
  REORDER_CARD: FEED,
  FLOCK_STAGE_SELECTOR: { ...ITEMS, ...FEED },
  NEWS_FEED: FEED,
  LIVE_ORDER_STRIP: FEED,
  REQUIREMENT_CALENDAR: FEED,
  APPOINTMENT_CARD: FEED,
  SHOP_BY_PROBLEM: ITEMS,
  BRAND_GRID: ITEMS,
};

/** One schema per widget, discriminated by `widget` (mobile model generators get typed classes). */
const section = Joi.alternatives()
  .match('one')
  .try(
    ...WIDGETS.map((w) =>
      Joi.object({ ...COMMON, widget: Joi.string().valid(w).required(), ...EXTRA[w] }).meta({
        className: className(w),
      }),
    ),
  )
  .meta({
    swagger: {
      discriminator: {
        propertyName: 'widget',
        mapping: Object.fromEntries(
          WIDGETS.map((w) => [w, `#/components/schemas/${className(w)}`]),
        ),
      },
    },
  });

const layoutView = Joi.object({
  schemaVersion: Joi.number().integer().example(1),
  page: Joi.string().valid(...PAGES),
  layoutNo: Joi.number().integer().allow(null),
  publishRev: Joi.number().integer().allow(null),
  sections: Joi.array().items(section),
}).meta({ className: 'HomeLayout' });

const homeMeta = Joi.object({
  authState: Joi.string().valid('none', 'ok', 'expired', 'unavailable'),
  region: Joi.string().allow(null).description('Territory of the farmer’s farm; null for guests'),
  degraded: Joi.array().items(Joi.string()).description('Sections dropped: upstream down'),
  stale: Joi.array().items(Joi.string()).description('Sections served from a stale copy'),
  ttlSeconds: Joi.number().integer(),
  timings: Joi.object().unknown(true).description('ms per section (not in prod)'),
}).meta({ className: 'HomeMeta' });

const FEED_DATA: Record<string, Joi.Schema> = {
  ORDER_LIVE: Joi.object().unknown(true).description('order-service order summary').allow(null),
  NEWS_LATEST: Joi.object({ items: Joi.array().items(Joi.object().unknown(true)) }).allow(null),
  FLOCK_CONTEXT: Joi.object({
    farmId: Joi.string().guid(),
    farmName: Joi.string(),
    farmCategory: Joi.string(),
    farmTypes: Joi.array().items(Joi.string()),
    birdCount: Joi.number().integer().allow(null),
    region: Joi.string().allow(null),
    stage: Joi.any().valid(null).description('⏳ Future'),
    ageWeeks: Joi.any().valid(null).description('⏳ Future'),
    shed: Joi.any().valid(null).description('⏳ Future'),
    productsForStage: Joi.any().valid(null).description('⏳ Future'),
  }).allow(null),
};

const feedResult = Joi.alternatives()
  .match('one')
  .try(
    ...FEED_KEYS.map((k) =>
      Joi.object({
        key: Joi.string().valid(k).required(),
        status: Joi.string().valid('OK', 'EMPTY', 'AUTH_REQUIRED', 'UNAVAILABLE', 'NOT_AVAILABLE'),
        data: FEED_DATA[k] ?? Joi.any().valid(null).description('⏳ Future: always null'),
      }).meta({ className: `HomeFeed${pascal(k)}` }),
    ),
  )
  .meta({
    swagger: {
      discriminator: {
        propertyName: 'key',
        mapping: Object.fromEntries(
          FEED_KEYS.map((k) => [k, `#/components/schemas/HomeFeed${pascal(k)}`]),
        ),
      },
    },
  });

// ── Examples (match the Figma) ──

const layoutEx = {
  schemaVersion: 1,
  page: 'HOME',
  layoutNo: 12,
  publishRev: 7,
  sections: [
    {
      key: 'hero',
      widget: 'BANNER_CAROUSEL',
      dataSource: 'BANNER_PLACEMENT',
      order: 1,
      eyebrow: null,
      title: null,
      subtitle: null,
      viewAllLink: null,
      minItems: 1,
      config: { placementCode: 'HOME_TOP', fallback: 'HIDE' },
      tracking: { id: 'HOME:12:hero' },
      banners: [
        {
          id: IDS.product,
          title: 'Enhance healthcare experience',
          imageUrl: 'https://cdn.farmx.in/banners/health-50.webp',
          mobileImageUrl: null,
          actionType: 'CATEGORY',
          actionTarget: 'medicines',
          sortOrder: 0,
        },
      ],
      aspectRatio: '16:9',
    },
    {
      key: 'categories',
      widget: 'CATEGORY_GRID',
      dataSource: 'STATIC_ITEMS',
      order: 2,
      eyebrow: null,
      title: 'Categories',
      subtitle: null,
      viewAllLink: 'farmx://categories',
      minItems: 1,
      config: { style: 'GRID_4', fallback: 'HIDE' },
      tracking: { id: 'HOME:12:categories' },
      items: [
        {
          id: IDS.wish,
          refType: 'CATEGORY',
          refId: IDS.address,
          refCode: null,
          label: 'Vaccines',
          subtitle: null,
          badge: null,
          image: {
            url: 'https://cdn.farmx.in/cat/vaccines.webp',
            width: 96,
            height: 96,
            aspectRatio: 1,
            variants: null,
            blurHash: null,
          },
          deepLink: 'farmx://category/vaccines',
          tracking: { id: `HOME:12:categories:${IDS.wish}` },
        },
      ],
    },
    {
      key: 'live-order',
      widget: 'LIVE_ORDER_STRIP',
      dataSource: 'REMOTE_FEED',
      order: 3,
      eyebrow: null,
      title: null,
      subtitle: null,
      viewAllLink: null,
      minItems: 1,
      config: { fallback: 'HIDE' },
      tracking: { id: 'HOME:12:live-order' },
      feed: {
        key: 'ORDER_LIVE',
        endpoint: '/v1/home/feeds?keys=ORDER_LIVE',
        requiresLogin: true,
        available: true,
      },
    },
    {
      key: 'featured',
      widget: 'PRODUCT_GRID_2X2',
      dataSource: 'DYNAMIC_QUERY',
      order: 4,
      eyebrow: null,
      title: 'Featured Product',
      subtitle: null,
      viewAllLink: 'farmx://products?isFeatured=true',
      minItems: 1,
      config: { query: { isFeatured: true }, fallback: 'HIDE' },
      tracking: { id: 'HOME:12:featured' },
      fetch: { endpoint: '/v1/home/sections/featured?page=HOME', limit: 4 },
      data: {
        items: [
          {
            id: IDS.product,
            name: 'ND LaSota live - Godavari Bio',
            slug: 'nd-lasota-live',
            isPrescriptionRequired: true,
            temperatureClass: 'CC_REF',
            isColdChain: true,
            imageUrl: 'https://cdn.farmx.in/products/lasota.webp',
            defaultVariant: {
              packSize: '1000',
              packUnit: { code: 'DOSES', name: 'Doses' },
              mrp: '380.00',
              sellingPrice: '345.00',
              discountPercent: 9,
            },
            inStock: true,
            tracking: { id: `HOME:12:featured:${IDS.product}` },
            actions: {
              primary: 'UPLOAD_RX',
              uploadRxLink: `farmx://rx/upload?productId=${IDS.product}`,
              call: { type: 'PHONE_ORDER', tel: '+918888888888' },
            },
            priceBreak: null,
            inStockAtDepot: null,
          },
        ],
        nextCursor: null,
      },
    },
  ],
};
const metaEx = {
  authState: 'ok',
  region: 'WG',
  degraded: [],
  stale: [],
  ttlSeconds: 30,
};

const pub = (extra: Omit<RouteDocs, 'tag' | 'auth' | 'public'>): RouteDocs => ({
  tag: HOME_TAG,
  auth: AUTH_OPTIONAL,
  public: true,
  ...extra,
});

const adm = (permission: string, extra: Omit<RouteDocs, 'tag' | 'auth' | 'permission'>) =>
  ({ tag: ADMIN_HOME_TAG, auth: AUTH_ADMIN, permission, ...extra }) satisfies RouteDocs;

const layoutRow = Joi.object({
  id: Joi.string().guid(),
  page: Joi.string().valid(...PAGES),
  layoutNo: Joi.number().integer(),
  name: Joi.string(),
  status: Joi.string().valid(...LAYOUT_STATUSES),
  notes: Joi.string().allow(null),
  settings: Joi.object().unknown(true),
  scheduledPublishAt: Joi.date().allow(null),
  publishedAt: Joi.date().allow(null),
  publishRev: Joi.number().integer().allow(null),
  version: Joi.number().integer().description('Send as `If-Match` on writes'),
  sections: Joi.array().items(Joi.object().unknown(true)),
})
  .unknown(true)
  .meta({ className: 'HomeLayoutAdmin' });

const sectionBody = {
  sectionKey: 'featured',
  widgetType: 'PRODUCT_GRID_2X2',
  dataSource: 'DYNAMIC_QUERY',
  title: { en: 'Featured Product', hi: 'विशेष उत्पाद' },
  viewAllLink: 'farmx://products?isFeatured=true',
  itemLimit: 4,
  inline: true,
  config: { query: { isFeatured: true } },
  targeting: { platforms: ['android', 'ios'], regions: ['WG'] },
};

const brokenEx = {
  message: 'Layout points to deleted or hidden catalog data (HOME_LAYOUT_BROKEN_REFS)',
  details: {
    issues: [
      {
        path: `sections.clearance.items.${IDS.wish}`,
        message: `PRODUCT ${IDS.product} (ND LaSota) no longer exists or is not on sale`,
      },
    ],
  },
};
const conflictEx = {
  message: 'The layout was changed by someone else; reload and retry',
  details: { reason: 'HOME_LAYOUT_VERSION_CONFLICT' },
};

export const HOME_DOCS = {
  layout: pub({
    operationId: 'getHomeLayout',
    summary: 'Home / All Categories layout (first paint)',
    description:
      'Ordered sections for this caller (platform, user type, farm region, app version, widget-set version, A/B bucket) with static items, banners and live root categories. Up to 3 `inline` product sections carry their first page in `data`; the others carry `fetch`. `REMOTE_FEED` widgets carry `feed` (load with `/v1/home/feeds`). Sections with fewer than `minItems` items are left out. Never fails on auth; a slow catalog / product service only drops or staleifies its own sections (`meta.degraded` / `meta.stale`).',
    rateLimit: LAYOUT_RATE,
    headers: CLIENT_HEADERS,
    success: {
      status: 200,
      description: 'Layout (304 when `If-None-Match` matches)',
      data: layoutView,
      meta: homeMeta,
      example: ok(layoutEx, metaEx),
      headers: ETAG_OUT,
    },
    errors: [422, 503],
  }),
  sectionsBatch: pub({
    operationId: 'getHomeSectionsBatch',
    summary: 'First page of several product sections',
    description:
      'For lower rails: one call for up to 6 section keys. Per key: `OK` (data), `NOT_FOUND` (not a product section this caller sees) or `DEGRADED` (product service down, no stale copy: hide the rail).',
    rateLimit: SECTIONS_RATE,
    headers: CLIENT_HEADERS,
    success: {
      status: 200,
      description: 'One entry per requested key',
      data: Joi.array().items(
        Joi.object({
          key: Joi.string(),
          status: Joi.string().valid('OK', 'NOT_FOUND', 'DEGRADED'),
          data: productPage.allow(null),
        }),
      ),
      meta: homeMeta,
      headers: ETAG_OUT,
    },
    errors: [422, 503],
  }),
  sectionPage: pub({
    operationId: 'getHomeSectionPage',
    summary: 'Next page of one product section',
    description:
      'Cursor pages (`limit` ≤ 50; pass `nextCursor` back as `cursor`). Live prices and stock from product-service; when the farmer’s depot is known and the section filters on stock, stock is at that depot (`inStockAtDepot`).',
    rateLimit: SECTIONS_RATE,
    headers: CLIENT_HEADERS,
    success: {
      status: 200,
      description: 'A page of product cards',
      data: productPage.keys({ key: Joi.string() }),
      meta: homeMeta,
      headers: ETAG_OUT,
    },
    errors: [404, 422, 503],
    errorExamples: {
      404: { message: 'Home section not found', details: { reason: 'HOME_SECTION_NOT_FOUND' } },
    },
  }),
  feeds: pub({
    operationId: 'getHomeFeeds',
    summary: 'Live widget data by allowlisted key',
    description:
      'Keys: ORDER_LIVE (latest active order), NEWS_LATEST, FLOCK_CONTEXT (your farm; stage / week / shed are ⏳ Future), and ⏳ Future keys APPOINTMENT_NEXT, BUY_AGAIN, VET_AVAILABILITY, REQUIREMENT_DUE (always `NOT_AVAILABLE` for now). Each key resolves on its own (400 ms); one slow service only makes its key `UNAVAILABLE`. Guests get `AUTH_REQUIRED` for personal keys.',
    rateLimit: FEEDS_RATE,
    headers: CLIENT_HEADERS,
    success: {
      status: 200,
      description: 'One result per key',
      data: Joi.array().items(feedResult),
      meta: Joi.object({ authState: Joi.string() }),
      example: ok(
        [
          {
            key: 'ORDER_LIVE',
            status: 'OK',
            data: { id: IDS.product, orderNo: 'ORD-91842', status: 'IN_FULFILMENT' },
          },
          { key: 'APPOINTMENT_NEXT', status: 'NOT_AVAILABLE', data: null },
        ],
        { authState: 'ok' },
      ),
    },
    errors: [422],
  }),

  // ── Admin ──
  list: adm('home_layout.view', {
    operationId: 'adminListHomeLayouts',
    summary: 'List layouts',
    description: 'Newest first. Filters: `page`, `status`. Cursor pages.',
    success: { status: 200, description: 'A page of layouts', data: layoutRow, paginated: true },
    errors: [422],
  }),
  get: adm('home_layout.view', {
    operationId: 'adminGetHomeLayout',
    summary: 'One layout with sections and items',
    success: {
      status: 200,
      description: 'Layout (`ETag` = version)',
      data: layoutRow,
      headers: { ETag: { description: 'Quoted `version`; send as `If-Match`.' } },
    },
    errors: [404],
  }),
  create: adm('home_layout.manage', {
    operationId: 'adminCreateHomeLayout',
    summary: 'New DRAFT layout (blank or a clone)',
    description:
      '`cloneFromId` copies another layout of the same page (sections, items, settings) into a new DRAFT, e.g. to edit the live one.',
    requestExample: { page: 'HOME', name: 'Diwali home', cloneFromId: IDS.address },
    success: { status: 201, description: 'Draft created', data: layoutRow },
    errors: [404, 422],
  }),
  replace: adm('home_layout.manage', {
    operationId: 'adminReplaceHomeLayout',
    summary: 'Save a DRAFT (whole layout)',
    description:
      'Replaces name, notes, settings and every section + item. Rules: unique `sectionKey`; ≤ 30 sections, ≤ 50 items each, ≤ 3 `inline`; widget ↔ dataSource ↔ feedKey must fit; every localized text needs `en`; deep links `farmx://` or an allowlisted https host; images on an allowlisted CDN host. `meta.warnings` lists targeting on ⏳ Future facts (such sections never show yet).',
    headers: IF_MATCH,
    requestExample: {
      name: 'Diwali home',
      settings: { orderPhones: { default: '+918888888888', byRegion: { WG: '+918877766655' } } },
      sections: [sectionBody],
    },
    success: {
      status: 200,
      description: 'Saved (`ETag` = new version)',
      data: layoutRow,
      meta: Joi.object({ warnings: Joi.array().items(Joi.object().unknown(true)) }),
    },
    errors: [400, 404, 409, 422],
    errorExamples: { 409: conflictEx },
  }),
  reorder: adm('home_layout.manage', {
    operationId: 'adminReorderHomeSections',
    summary: 'Reorder sections of a DRAFT',
    headers: IF_MATCH,
    requestExample: { keys: ['hero', 'categories', 'featured'] },
    success: { status: 200, description: 'Reordered', data: layoutRow },
    errors: [400, 404, 409, 422],
  }),
  preview: adm('home_layout.view', {
    operationId: 'adminPreviewHomeLayout',
    summary: 'Preview any layout as a given caller',
    description:
      'Runs the same rule engine on any layout (drafts too) as the caller described by the query (`at` = a moment in time). No caches.',
    success: {
      status: 200,
      description: 'What that caller would see',
      data: layoutView,
      meta: homeMeta,
    },
    errors: [404, 422],
  }),
  validate: adm('home_layout.manage', {
    operationId: 'adminValidateHomeLayout',
    summary: 'Check catalog references now',
    description:
      'Re-checks every category, brand, disease, flock stage, product and banner placement the layout points to and stores the result on each item (`refBroken`; broken items stop showing). 503 when a catalog service is down.',
    success: {
      status: 200,
      description: 'Broken references',
      data: Joi.object({
        broken: Joi.array().items(Joi.object().unknown(true)),
        blocking: Joi.number().integer(),
      }),
    },
    errors: [404, 503],
  }),
  publish: adm('home_layout.publish', {
    operationId: 'adminPublishHomeLayout',
    summary: 'Publish now, or schedule',
    description:
      'DRAFT / SCHEDULED → live (the old live layout is ARCHIVED), or with `scheduledPublishAt` → SCHEDULED (one per page: a new schedule sends the old one back to DRAFT). Runs the reference check first: broken active refs → 422.',
    headers: IF_MATCH,
    requestExample: {
      reason: 'Diwali campaign layout',
      scheduledPublishAt: '2026-11-28T00:00:00.000Z',
    },
    success: { status: 200, description: 'Published or scheduled', data: layoutRow },
    errors: [400, 404, 409, 422, 503],
    errorExamples: { 409: conflictEx, 422: brokenEx },
  }),
  rollback: adm('home_layout.publish', {
    operationId: 'adminRollbackHomeLayout',
    summary: 'Re-publish an ARCHIVED layout',
    description: 'One click back to an earlier layout. Same reference check as publish.',
    headers: IF_MATCH,
    requestExample: { reason: 'New layout broke the vaccine rail' },
    success: { status: 200, description: 'Live again', data: layoutRow },
    errors: [400, 404, 409, 422, 503],
    errorExamples: { 409: conflictEx, 422: brokenEx },
  }),
  history: adm('home_layout.view', {
    operationId: 'adminHomeLayoutHistory',
    summary: 'Audit trail of a layout',
    success: {
      status: 200,
      description: 'Audit rows, newest first',
      data: Joi.object().unknown(true),
      paginated: true,
    },
    errors: [404, 422],
  }),
} satisfies Record<string, RouteDocs>;
