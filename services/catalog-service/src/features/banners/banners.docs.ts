import type { DocHeader, RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDEMPOTENCY_KEY, IDS, ok, reasonIssue } from '../../docs/shared.js';
import { ACTION_TYPES } from './banners.types.js';

export const BANNERS_TAG = 'Catalog · Banners';
export const ADMIN_BANNERS_TAG = 'Admin · Catalog Banners';

const AUTH_PUBLIC =
  'None (public storefront). Only active placements and live banners (active, inside the schedule window) are returned.';
const PUBLIC_RATE = '300 per IP per minute';
const PERMISSION = 'catalogue.manage';

// ── Headers ──

const IF_NONE_MATCH: Record<string, DocHeader> = {
  'If-None-Match': {
    description:
      'ETag from the previous response. If the visible banners did not change the server answers **304 Not Modified** with an empty body.',
    schema: { type: 'string', example: 'W/"Xk2q9cP1aB7dLmN0rT5uVw"' },
  },
};
const RESPONSE_ETAG: Record<string, DocHeader> = {
  ETag: {
    description:
      'Weak ETag of exactly what was returned (changes on any edit and when a banner goes live or expires).',
    schema: { type: 'string', example: 'W/"Xk2q9cP1aB7dLmN0rT5uVw"' },
  },
  'Cache-Control': {
    description: '`public, max-age=30, stale-while-revalidate=120`',
    schema: { type: 'string' },
  },
};
const IF_MATCH: Record<string, DocHeader> = {
  'If-Match': {
    description:
      '`version` from the last read (`3`, `"3"` or `W/"3"`). If it differs → 409 `BANNER_VERSION_CONFLICT`. Optional, recommended on every write.',
    schema: { type: 'string', example: '"3"' },
  },
};
const VERSION_ETAG: Record<string, DocHeader> = {
  ETag: {
    description: 'Current `version`, quoted. Send it back as `If-Match` on the next write.',
    schema: { type: 'string', example: '"3"' },
  },
};

// ── Schemas ──

const publicBanner = Joi.object({
  id: Joi.string().guid(),
  title: Joi.string().example('Winter vaccine sale'),
  subtitle: Joi.string().allow(null),
  imageUrl: Joi.string().uri(),
  mobileImageUrl: Joi.string().uri().allow(null),
  actionType: Joi.string().valid(...ACTION_TYPES),
  actionTarget: Joi.string()
    .allow(null)
    .description('uuid for PRODUCT/CATEGORY/BRAND, https URL, or farmx:// deep link'),
  sortOrder: Joi.number().integer(),
}).meta({ className: 'Banner' });

const publicPlacement = Joi.object({
  code: Joi.string().example('FARMER_HOME_HERO'),
  app: Joi.string().example('FARMER'),
  page: Joi.string().example('HOME'),
  position: Joi.string().example('HERO_SLIDER'),
  aspectRatio: Joi.string().example('16:9'),
  maxItems: Joi.number().integer(),
  banners: Joi.array().items(publicBanner),
}).meta({ className: 'BannerPlacement' });

const audit = {
  version: Joi.number().integer().description('Send as `If-Match` on writes'),
  createdByUserId: Joi.string().guid(),
  updatedByUserId: Joi.string().guid(),
  createdAt: Joi.date(),
  updatedAt: Joi.date(),
};

const adminPlacement = Joi.object({
  id: Joi.string().guid(),
  code: Joi.string(),
  name: Joi.string(),
  app: Joi.string(),
  page: Joi.string(),
  position: Joi.string(),
  aspectRatio: Joi.string(),
  maxItems: Joi.number().integer(),
  isActive: Joi.boolean(),
  ...audit,
}).meta({ className: 'AdminBannerPlacement' });

const adminBanner = Joi.object({
  id: Joi.string().guid(),
  placementId: Joi.string().guid(),
  title: Joi.string(),
  subtitle: Joi.string().allow(null),
  imageUrl: Joi.string().uri(),
  mobileImageUrl: Joi.string().uri().allow(null),
  actionType: Joi.string().valid(...ACTION_TYPES),
  actionTarget: Joi.string().allow(null),
  sortOrder: Joi.number().integer(),
  isActive: Joi.boolean(),
  startDate: Joi.date().allow(null),
  endDate: Joi.date().allow(null),
  ...audit,
}).meta({ className: 'AdminBanner' });

const auditRecord = Joi.object({
  id: Joi.string().guid(),
  actorUserId: Joi.string().guid(),
  action: Joi.string().example('banner.update'),
  reason: Joi.string().allow(null),
  createdAt: Joi.date(),
}).meta({ className: 'BannerAuditRecord' });

// ── Examples ──

const at = '2026-11-16T09:30:00.000Z';
const PLACEMENT_ID = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8a01';
const BANNER_ID = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b01';
const bannerEx = {
  id: BANNER_ID,
  title: 'Winter vaccine sale',
  subtitle: 'Up to 20% off on ND vaccines',
  imageUrl: 'https://cdn.farmx.in/banners/winter-sale.webp',
  mobileImageUrl: 'https://cdn.farmx.in/banners/winter-sale-m.webp',
  actionType: 'CATEGORY',
  actionTarget: IDS.vaccines,
  sortOrder: 10,
};
const placementEx = {
  code: 'FARMER_HOME_HERO',
  app: 'FARMER',
  page: 'HOME',
  position: 'HERO_SLIDER',
  aspectRatio: '16:9',
  maxItems: 5,
  banners: [bannerEx],
};
const stamps = {
  createdByUserId: IDS.admin,
  updatedByUserId: IDS.admin,
  createdAt: at,
  updatedAt: at,
};
const adminPlacementEx = {
  id: PLACEMENT_ID,
  code: 'FARMER_HOME_HERO',
  name: 'Farmer app · Home hero slider',
  app: 'FARMER',
  page: 'HOME',
  position: 'HERO_SLIDER',
  aspectRatio: '16:9',
  maxItems: 5,
  isActive: true,
  version: 0,
  ...stamps,
};
const adminBannerEx = {
  ...bannerEx,
  placementId: PLACEMENT_ID,
  isActive: true,
  startDate: '2026-12-01T00:00:00.000Z',
  endDate: '2027-01-15T00:00:00.000Z',
  version: 0,
  ...stamps,
};
const page = { nextCursor: null, limit: 20 };
const placementNotFound = { message: 'Banner placement not found' };
const bannerNotFound = { message: 'Banner not found' };
const versionConflict = {
  summary: 'BANNER_VERSION_CONFLICT (stale If-Match)',
  message: 'The banner was changed by someone else; reload and retry',
  details: { reason: 'BANNER_VERSION_CONFLICT', currentVersion: 4 },
};
const duplicate = {
  summary: 'PLACEMENT_DUPLICATE (code taken)',
  message: 'A placement with this code already exists',
  details: { reason: 'PLACEMENT_DUPLICATE', fields: ['code'] },
};
const inUse = {
  summary: 'PLACEMENT_IN_USE (still has banners)',
  message: 'The placement still has banners; move or delete them first',
  details: { reason: 'PLACEMENT_IN_USE', bannerCount: 3 },
};
const historyEx = (action: string) =>
  ok(
    [{ id: IDS.audit, actorUserId: IDS.admin, action, reason: 'Campaign update', createdAt: at }],
    page,
  );

const admin = (extra: Omit<RouteDocs, 'tag' | 'auth' | 'permission'>): RouteDocs => ({
  tag: ADMIN_BANNERS_TAG,
  auth: AUTH_ADMIN,
  permission: PERMISSION,
  ...extra,
});

export const BANNER_DOCS = {
  // ── Storefront ──
  publicList: {
    tag: BANNERS_TAG,
    operationId: 'listBanners',
    summary: 'Live banners for an app (optionally one page / position)',
    description:
      'Returns every active placement of `app` (filtered by `page` / `position`) with its live banners, sorted by `sortOrder` and capped at the placement `maxItems`. Served from memory (no database hit); send `If-None-Match` to get **304** when nothing changed.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Placements with their banners (or 304 Not Modified with an empty body)',
      data: Joi.array().items(publicPlacement),
      example: ok([placementEx]),
      headers: RESPONSE_ETAG,
    },
    errors: [422],
  },
  publicByCode: {
    tag: BANNERS_TAG,
    operationId: 'getBannerPlacement',
    summary: 'Live banners of one placement by code',
    description:
      'The app hard-codes the slot code (`FARMER_HOME_HERO`). Unknown, deleted and inactive placements → 404. A placement with no live banner returns `banners: []`.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Placement with its banners',
      data: publicPlacement,
      example: ok(placementEx),
      headers: RESPONSE_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: placementNotFound },
  },

  // ── Admin ──
  list: admin({
    operationId: 'adminListBanners',
    summary: 'List banners (cursor pagination)',
    description:
      'Filter by `placementId`, `isActive`, `state` (`LIVE` | `SCHEDULED` | `EXPIRED` | `INACTIVE`, evaluated now) and `q` (title). Ordered by placement, then `sortOrder`. Pass `meta.nextCursor` as `cursor` for the next page.',
    success: {
      status: 200,
      description: 'A page of banners',
      data: adminBanner,
      paginated: true,
      example: ok([adminBannerEx], page),
    },
    errors: [422],
  }),
  get: admin({
    operationId: 'adminGetBanner',
    summary: 'Banner detail',
    success: {
      status: 200,
      description: 'Banner',
      data: adminBanner,
      example: ok(adminBannerEx),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: bannerNotFound },
  }),
  history: admin({
    operationId: 'adminBannerHistory',
    summary: 'Change history (audit log) of a banner',
    success: {
      status: 200,
      description: 'A page of audit rows',
      data: auditRecord,
      paginated: true,
      example: historyEx('banner.update'),
    },
    errors: [422],
  }),
  create: admin({
    operationId: 'adminCreateBanner',
    summary: 'Create a banner in a placement',
    description:
      '`actionTarget` depends on `actionType`: PRODUCT / CATEGORY / BRAND → uuid, EXTERNAL_URL → https URL, DEEP_LINK → `farmx://…`, NONE → omit. `startDate` / `endDate` (ISO) schedule it; null = open-ended. Audited.',
    headers: IDEMPOTENCY_KEY,
    requestExample: {
      placementId: PLACEMENT_ID,
      title: 'Winter vaccine sale',
      subtitle: 'Up to 20% off on ND vaccines',
      imageUrl: 'https://cdn.farmx.in/banners/winter-sale.webp',
      mobileImageUrl: 'https://cdn.farmx.in/banners/winter-sale-m.webp',
      actionType: 'CATEGORY',
      actionTarget: IDS.vaccines,
      sortOrder: 10,
      startDate: '2026-12-01T00:00:00.000Z',
      endDate: '2027-01-15T00:00:00.000Z',
      reason: 'Winter campaign hero banner',
    },
    success: {
      status: 201,
      description: 'Created',
      data: adminBanner,
      example: ok(adminBannerEx),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: placementNotFound, 422: reasonIssue },
  }),
  update: admin({
    operationId: 'adminUpdateBanner',
    summary: 'Update a banner',
    description:
      '`reason` plus at least one field. Send `actionType` and `actionTarget` together. Changing `placementId` moves the banner. Audited with before/after.',
    headers: IF_MATCH,
    requestExample: {
      endDate: '2027-01-31T00:00:00.000Z',
      reason: 'Extend the winter campaign',
    },
    success: {
      status: 200,
      description: 'Updated',
      data: adminBanner,
      example: ok({ ...adminBannerEx, version: 1 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: bannerNotFound, 409: versionConflict, 422: reasonIssue },
  }),
  status: admin({
    operationId: 'adminSetBannerStatus',
    summary: 'Activate / deactivate a banner',
    description: 'Takes effect on the storefront at once (cache dropped). Audited.',
    headers: IF_MATCH,
    requestExample: { isActive: false, reason: 'Campaign paused by marketing' },
    success: {
      status: 200,
      description: 'Updated',
      data: adminBanner,
      example: ok({ ...adminBannerEx, isActive: false, version: 1 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: bannerNotFound, 409: versionConflict },
  }),
  reorder: admin({
    operationId: 'adminReorderBanners',
    summary: 'Reorder banners inside a placement',
    description:
      'Listed ids get `sortOrder` 10, 20, 30 … in order (one statement). Every id must be a live banner of the placement, else 422. Audited.',
    requestExample: {
      placementId: PLACEMENT_ID,
      ids: [BANNER_ID, '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b02'],
      reason: 'Move the sale banner first',
    },
    success: {
      status: 200,
      description: 'Rows updated',
      data: Joi.object({ updated: Joi.number().integer() }),
      example: ok({ updated: 2 }),
    },
    errors: [404, 422],
    errorExamples: { 404: placementNotFound },
  }),
  remove: admin({
    operationId: 'adminDeleteBanner',
    summary: 'Delete a banner (soft delete)',
    description: '`reason` goes in the query string. The audit history is kept.',
    headers: IF_MATCH,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 409, 422],
    errorExamples: { 404: bannerNotFound, 409: versionConflict },
  }),
} satisfies Record<string, RouteDocs>;

export const PLACEMENT_DOCS = {
  list: admin({
    operationId: 'adminListBannerPlacements',
    summary: 'List banner placements (slots)',
    description:
      'Filter by `app`, `page`, `position`, `isActive`; `q` searches code and name. Cursor pagination.',
    success: {
      status: 200,
      description: 'A page of placements',
      data: adminPlacement,
      paginated: true,
      example: ok([adminPlacementEx], page),
    },
    errors: [422],
  }),
  get: admin({
    operationId: 'adminGetBannerPlacement',
    summary: 'Placement detail',
    success: {
      status: 200,
      description: 'Placement',
      data: adminPlacement,
      example: ok(adminPlacementEx),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: placementNotFound },
  }),
  history: admin({
    operationId: 'adminBannerPlacementHistory',
    summary: 'Change history of a placement (incl. reorders)',
    success: {
      status: 200,
      description: 'A page of audit rows',
      data: auditRecord,
      paginated: true,
      example: historyEx('banner_placement.update'),
    },
    errors: [422],
  }),
  create: admin({
    operationId: 'adminCreateBannerPlacement',
    summary: 'Create a placement (new slot, no deploy needed)',
    description:
      '`code`, `app`, `page`, `position` are upper-case keys (lower-case input is upper-cased). `code` is unique and **immutable** — apps hard-code it. Audited.',
    headers: IDEMPOTENCY_KEY,
    requestExample: {
      code: 'FARMER_HOME_HERO',
      name: 'Farmer app · Home hero slider',
      app: 'FARMER',
      page: 'HOME',
      position: 'HERO_SLIDER',
      aspectRatio: '16:9',
      maxItems: 5,
      reason: 'New hero slider on the farmer home page',
    },
    success: {
      status: 201,
      description: 'Created',
      data: adminPlacement,
      example: ok(adminPlacementEx),
      headers: VERSION_ETAG,
    },
    errors: [409, 422],
    errorExamples: { 409: duplicate, 422: reasonIssue },
  }),
  update: admin({
    operationId: 'adminUpdateBannerPlacement',
    summary: 'Update a placement',
    description: '`reason` plus at least one field (`code` cannot change). Audited.',
    headers: IF_MATCH,
    requestExample: { maxItems: 8, reason: 'Allow more slides on the hero' },
    success: {
      status: 200,
      description: 'Updated',
      data: adminPlacement,
      example: ok({ ...adminPlacementEx, maxItems: 8, version: 1 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: placementNotFound, 409: versionConflict, 422: reasonIssue },
  }),
  status: admin({
    operationId: 'adminSetBannerPlacementStatus',
    summary: 'Activate / deactivate a placement',
    description: 'An inactive placement disappears from the storefront with all its banners.',
    headers: IF_MATCH,
    requestExample: { isActive: false, reason: 'Hide hero slider during app redesign' },
    success: {
      status: 200,
      description: 'Updated',
      data: adminPlacement,
      example: ok({ ...adminPlacementEx, isActive: false, version: 1 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: placementNotFound, 409: versionConflict },
  }),
  remove: admin({
    operationId: 'adminDeleteBannerPlacement',
    summary: 'Delete a placement (soft delete)',
    description:
      'Blocked (409 `PLACEMENT_IN_USE`) while it still has banners. The code becomes free again.',
    headers: IF_MATCH,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 409, 422],
    errorExamples: { 404: placementNotFound, 409: [inUse, versionConflict] },
  }),
} satisfies Record<string, RouteDocs>;
