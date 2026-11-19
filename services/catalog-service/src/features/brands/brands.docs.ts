import type { DocHeader, RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDEMPOTENCY_KEY, IDS, ok, reasonIssue } from '../../docs/shared.js';

export const BRANDS_TAG = 'Catalog · Brands';
export const ADMIN_BRANDS_TAG = 'Admin · Catalog Brands';

const AUTH_PUBLIC = 'None (public storefront). Only active brands are visible.';
const PUBLIC_RATE = '120 per IP per minute';
const PERMISSION = 'catalogue.manage';

// ── Headers ──

const IF_NONE_MATCH: Record<string, DocHeader> = {
  'If-None-Match': {
    description:
      'ETag from the previous response. If no brand changed the server answers **304 Not Modified** with an empty body.',
    schema: { type: 'string', example: 'W/"b7Qm1x0aK2c9Zr4tY8pL3w"' },
  },
};
const SNAPSHOT_ETAG: Record<string, DocHeader> = {
  ETag: {
    description: 'Weak ETag of the active brand list. Send it back as `If-None-Match`.',
    schema: { type: 'string', example: 'W/"b7Qm1x0aK2c9Zr4tY8pL3w"' },
  },
  'Cache-Control': {
    description: '`public, max-age=60, stale-while-revalidate=300`',
    schema: { type: 'string' },
  },
};
const IF_MATCH: Record<string, DocHeader> = {
  'If-Match': {
    description:
      'Brand `version` from the last read (`3`, `"3"` or `W/"3"`). If it differs → 409 `BRAND_VERSION_CONFLICT`. Optional, recommended on every write.',
    schema: { type: 'string', example: '"3"' },
  },
};
const VERSION_ETAG: Record<string, DocHeader> = {
  ETag: {
    description: 'Current brand `version`, quoted. Send it back as `If-Match` on the next write.',
    schema: { type: 'string', example: '"3"' },
  },
};

// ── Schemas ──

const publicFields = {
  id: Joi.string().guid(),
  name: Joi.string().example('Zoetis'),
  slug: Joi.string().example('zoetis'),
  code: Joi.string().example('ZOETIS').description('Unique upper-case brand code'),
  description: Joi.string().allow(null),
  logoUrl: Joi.string().uri().allow(null),
  bannerUrl: Joi.string().uri().allow(null),
  websiteUrl: Joi.string().uri().allow(null),
  countryOfOrigin: Joi.string().length(2).allow(null).description('ISO 3166-1 alpha-2'),
  isFeatured: Joi.boolean(),
  sortOrder: Joi.number().integer(),
};

const publicBrand = Joi.object(publicFields).meta({ className: 'Brand' });

const adminBrand = Joi.object({
  ...publicFields,
  isActive: Joi.boolean().description('false = hidden from the storefront'),
  version: Joi.number().integer().description('Send as `If-Match` on writes'),
  createdByUserId: Joi.string().guid(),
  updatedByUserId: Joi.string().guid(),
  createdAt: Joi.date(),
  updatedAt: Joi.date(),
}).meta({ className: 'AdminBrand' });

const auditRecord = Joi.object({
  id: Joi.string().guid(),
  actorUserId: Joi.string().guid(),
  action: Joi.string().example('brand.update'),
  reason: Joi.string().allow(null),
  createdAt: Joi.date(),
}).meta({ className: 'BrandAuditRecord' });

// ── Examples ──

const at = '2026-11-14T09:30:00.000Z';
const BRAND_ID = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7b01';
const zoetis = {
  id: BRAND_ID,
  name: 'Zoetis',
  slug: 'zoetis',
  code: 'ZOETIS',
  description: 'Animal health vaccines and medicines.',
  logoUrl: 'https://cdn.farmx.in/brands/zoetis-logo.webp',
  bannerUrl: 'https://cdn.farmx.in/brands/zoetis-banner.webp',
  websiteUrl: 'https://www.zoetis.com',
  countryOfOrigin: 'US',
  isFeatured: true,
  sortOrder: 10,
};
const venkys = {
  ...zoetis,
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7b02',
  name: "Venky's Animal Health",
  slug: 'venkys-animal-health',
  code: 'VENKYS-AH',
  description: null,
  bannerUrl: null,
  websiteUrl: null,
  countryOfOrigin: 'IN',
  isFeatured: false,
  sortOrder: 20,
};
const adminExample = {
  ...zoetis,
  isActive: true,
  version: 3,
  createdByUserId: IDS.admin,
  updatedByUserId: IDS.admin,
  createdAt: at,
  updatedAt: at,
};

const notFound = { message: 'Brand not found' };
const duplicate = {
  summary: 'BRAND_DUPLICATE (name, slug or code taken)',
  message: 'A brand with this code already exists',
  details: { reason: 'BRAND_DUPLICATE', fields: ['code'] },
};
const versionConflict = {
  summary: 'BRAND_VERSION_CONFLICT (stale If-Match)',
  message: 'The brand was changed by someone else; reload and retry',
  details: { reason: 'BRAND_VERSION_CONFLICT', currentVersion: 4 },
};
const page = { nextCursor: null, limit: 20 };

export const BRAND_DOCS = {
  // ── Storefront ──
  publicList: {
    tag: BRANDS_TAG,
    operationId: 'listBrands',
    summary: 'List / search active brands',
    description:
      '`q` searches name, code and slug (case-insensitive); `isFeatured=true` returns featured brands only (home-page strip). Ordered by `sortOrder`, then name. Served from cache (no database hit); send `If-None-Match` to get **304** when nothing changed.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'A page of brands (or 304 Not Modified with an empty body)',
      data: publicBrand,
      paginated: true,
      example: ok([zoetis, venkys], page),
      headers: SNAPSHOT_ETAG,
    },
    errors: [422],
  },
  publicDetail: {
    tag: BRANDS_TAG,
    operationId: 'getBrand',
    summary: 'Brand page by slug or id',
    description: 'Unknown, deleted and inactive brands all answer 404.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Brand',
      data: publicBrand,
      example: ok(zoetis),
      headers: SNAPSHOT_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },

  // ── Admin reads ──
  list: {
    tag: ADMIN_BRANDS_TAG,
    operationId: 'adminListBrands',
    summary: 'List brands (including inactive)',
    description: '`q` searches name, code and slug. Filter with `isActive` / `isFeatured`.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    success: {
      status: 200,
      description: 'A page of brands',
      data: adminBrand,
      paginated: true,
      example: ok([adminExample], page),
    },
    errors: [422],
  },
  get: {
    tag: ADMIN_BRANDS_TAG,
    operationId: 'adminGetBrand',
    summary: 'Brand detail',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    success: {
      status: 200,
      description: 'Brand',
      data: adminBrand,
      example: ok(adminExample),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },
  history: {
    tag: ADMIN_BRANDS_TAG,
    operationId: 'adminBrandHistory',
    summary: 'Change history (audit log) of a brand',
    description: 'Newest first. Kept after the brand is deleted.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    success: {
      status: 200,
      description: 'A page of audit rows',
      data: auditRecord,
      paginated: true,
      example: ok(
        [
          {
            id: IDS.audit,
            actorUserId: IDS.admin,
            action: 'brand.status',
            reason: 'Featured for the winter vaccine campaign',
            createdAt: at,
          },
        ],
        page,
      ),
    },
    errors: [422],
  },

  // ── Admin writes ──
  create: {
    tag: ADMIN_BRANDS_TAG,
    operationId: 'adminCreateBrand',
    summary: 'Create a brand',
    description:
      '`code` is stored upper-case. `slug` is generated from `name` when omitted (`zoetis`, `zoetis-2` …). Name (case-insensitive), slug and code are unique among live brands. Audited.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IDEMPOTENCY_KEY,
    requestExample: {
      name: 'Zoetis',
      code: 'zoetis',
      description: 'Animal health vaccines and medicines.',
      logoUrl: 'https://cdn.farmx.in/brands/zoetis-logo.webp',
      websiteUrl: 'https://www.zoetis.com',
      countryOfOrigin: 'US',
      isFeatured: true,
      sortOrder: 10,
      reason: 'Onboarding Zoetis as a catalogue brand',
    },
    success: {
      status: 201,
      description: 'Created',
      data: adminBrand,
      example: ok({ ...adminExample, version: 0 }),
      headers: VERSION_ETAG,
    },
    errors: [409, 422],
    errorExamples: { 409: duplicate, 422: reasonIssue },
  },
  update: {
    tag: ADMIN_BRANDS_TAG,
    operationId: 'adminUpdateBrand',
    summary: 'Update a brand',
    description: '`reason` plus at least one field. Audited with before/after.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IF_MATCH,
    requestExample: {
      bannerUrl: 'https://cdn.farmx.in/brands/zoetis-banner-v2.webp',
      sortOrder: 5,
      reason: 'New banner for the winter campaign',
    },
    success: {
      status: 200,
      description: 'Updated',
      data: adminBrand,
      example: ok({ ...adminExample, version: 4 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: notFound, 409: [duplicate, versionConflict], 422: reasonIssue },
  },
  status: {
    tag: ADMIN_BRANDS_TAG,
    operationId: 'adminSetBrandStatus',
    summary: 'Activate / deactivate or feature / unfeature a brand',
    description:
      'Send `isActive` and/or `isFeatured` plus `reason`. `isActive: false` hides the brand from the storefront at once (cache dropped). Audited.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IF_MATCH,
    requestExample: { isFeatured: true, reason: 'Featured for the winter vaccine campaign' },
    success: {
      status: 200,
      description: 'Updated',
      data: adminBrand,
      example: ok({ ...adminExample, version: 4 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: notFound, 409: versionConflict },
  },
  remove: {
    tag: ADMIN_BRANDS_TAG,
    operationId: 'adminDeleteBrand',
    summary: 'Delete a brand (soft delete)',
    description:
      'Name, slug and code become free again; the audit history is kept. `reason` goes in the query string.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IF_MATCH,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 409, 422],
    errorExamples: { 404: notFound, 409: versionConflict },
  },
} satisfies Record<string, RouteDocs>;
