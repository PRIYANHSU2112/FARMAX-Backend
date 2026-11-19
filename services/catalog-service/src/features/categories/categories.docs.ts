import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import {
  AUTH_ADMIN,
  AUTH_PUBLIC,
  IDEMPOTENCY_KEY,
  IDS,
  IF_MATCH,
  IF_NONE_MATCH,
  TREE_ETAG,
  VERSION_ETAG,
  ok,
  reasonIssue,
} from '../../docs/shared.js';

export const CATEGORIES_TAG = 'Catalog · Categories';
export const ADMIN_CATEGORIES_TAG = 'Admin · Catalog Categories';

// ── Schemas (className → reusable component) ──

const breadcrumb = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string().example('Vaccines'),
  nameTe: Joi.string().allow(null).example('టీకాలు'),
  slug: Joi.string().example('vaccines'),
}).meta({ className: 'CategoryBreadcrumb' });

const summaryFields = {
  id: Joi.string().guid(),
  parentId: Joi.string().guid().allow(null).description('null = root category'),
  name: Joi.string().example('Live Vaccines'),
  nameTe: Joi.string().allow(null),
  slug: Joi.string().example('live-vaccines'),
  imageUrl: Joi.string().uri().allow(null),
  depth: Joi.number().integer().description('0 = root, 1 = sub-category, 2 = sub-sub-category …'),
  sortOrder: Joi.number().integer(),
  childCount: Joi.number()
    .integer()
    .description('Direct sub-categories (visible ones on public routes)'),
};

const summary = Joi.object(summaryFields).meta({ className: 'CategorySummary' });

const node = Joi.object({
  ...summaryFields,
  children: Joi.array()
    .items(Joi.object().unknown().description('CategoryNode (same shape, recursive)'))
    .description('Sub-categories, same shape, nested to any depth'),
}).meta({ className: 'CategoryNode' });

const publicDetail = Joi.object({
  category: Joi.object({ ...summaryFields, description: Joi.string().allow(null) }),
  breadcrumbs: Joi.array()
    .items(breadcrumb)
    .description('Root → parent (excludes the category itself)'),
  children: Joi.array().items(summary),
}).meta({ className: 'CategoryPage' });

const adminFields = {
  id: Joi.string().guid(),
  parentId: Joi.string().guid().allow(null),
  path: Joi.string().description('Materialized path of ids, root first: `/<rootId>/…/<id>/`'),
  depth: Joi.number().integer(),
  name: Joi.string(),
  nameTe: Joi.string().allow(null),
  slug: Joi.string(),
  description: Joi.string().allow(null),
  imageUrl: Joi.string().uri().allow(null),
  sortOrder: Joi.number().integer(),
  isActive: Joi.boolean().description('Own flag'),
  effectiveActive: Joi.boolean().description(
    'Own flag AND every ancestor active = shown on the storefront',
  ),
  version: Joi.number().integer().description('Send as `If-Match` on writes'),
  childCount: Joi.number().integer(),
  createdByUserId: Joi.string().guid(),
  updatedByUserId: Joi.string().guid(),
  createdAt: Joi.date(),
  updatedAt: Joi.date(),
};

const adminCategory = Joi.object(adminFields).meta({ className: 'Category' });

const adminDetail = Joi.object({
  ...adminFields,
  ancestors: Joi.array().items(breadcrumb),
  children: Joi.array().items(Joi.object({ ...summaryFields, isActive: Joi.boolean() })),
}).meta({ className: 'CategoryDetail' });

const adminNode = Joi.object({
  ...summaryFields,
  isActive: Joi.boolean(),
  effectiveActive: Joi.boolean(),
  children: Joi.array().items(Joi.object().unknown().description('AdminCategoryNode (recursive)')),
}).meta({ className: 'AdminCategoryNode' });

const auditRecord = Joi.object({
  id: Joi.string().guid(),
  actorUserId: Joi.string().guid(),
  action: Joi.string().example('category.move'),
  reason: Joi.string().allow(null),
  createdAt: Joi.date(),
}).meta({ className: 'CatalogAuditRecord' });

// ── Examples ──

const at = '2026-11-14T09:30:00.000Z';
const vaccines = {
  id: IDS.vaccines,
  parentId: null,
  name: 'Vaccines',
  nameTe: 'టీకాలు',
  slug: 'vaccines',
  imageUrl: 'https://cdn.farmx.in/categories/vaccines.webp',
  depth: 0,
  sortOrder: 10,
  childCount: 1,
};
const live = {
  id: IDS.live,
  parentId: IDS.vaccines,
  name: 'Live Vaccines',
  nameTe: null,
  slug: 'live-vaccines',
  imageUrl: null,
  depth: 1,
  sortOrder: 10,
  childCount: 2,
};
const nd = {
  id: IDS.nd,
  parentId: IDS.live,
  name: 'ND Vaccines',
  nameTe: null,
  slug: 'nd-vaccines',
  imageUrl: null,
  depth: 2,
  sortOrder: 10,
  childCount: 0,
};
const ibd = { ...nd, id: IDS.ibd, name: 'IBD Vaccines', slug: 'ibd-vaccines', sortOrder: 20 };
const treeExample = [
  {
    ...vaccines,
    children: [
      {
        ...live,
        children: [
          { ...nd, children: [] },
          { ...ibd, children: [] },
        ],
      },
    ],
  },
  {
    ...vaccines,
    id: IDS.medicines,
    name: 'Medicines',
    nameTe: 'మందులు',
    slug: 'medicines',
    sortOrder: 20,
    childCount: 0,
    children: [],
  },
];
const adminExample = {
  ...live,
  path: `/${IDS.vaccines}/${IDS.live}/`,
  description: 'Freeze-dried live vaccines (cold chain 2–8 °C).',
  isActive: true,
  effectiveActive: true,
  version: 3,
  createdByUserId: IDS.admin,
  updatedByUserId: IDS.admin,
  createdAt: at,
  updatedAt: at,
};
const crumbOf = (c: typeof vaccines) => ({
  id: c.id,
  name: c.name,
  nameTe: c.nameTe,
  slug: c.slug,
});

const notFound = { message: 'Category not found' };
const versionConflict = {
  summary: 'CATEGORY_VERSION_CONFLICT (stale If-Match)',
  message: 'The category was changed by someone else; reload and retry',
  details: { reason: 'CATEGORY_VERSION_CONFLICT', currentVersion: 4 },
};
const slugTaken = {
  summary: 'CATEGORY_SLUG_TAKEN',
  message: 'A category with this slug already exists',
  details: { reason: 'CATEGORY_SLUG_TAKEN', fields: ['slug'] },
};
const nameTaken = {
  summary: 'CATEGORY_NAME_TAKEN (same name under the same parent)',
  message: 'A sibling category with this name already exists',
  details: { reason: 'CATEGORY_NAME_TAKEN', fields: ['name'] },
};
const parentMissing = {
  summary: 'Parent not found',
  message: 'Validation failed',
  details: { issues: [{ path: 'parentId', message: 'Parent category not found' }] },
};

const PUBLIC_RATE = '120 per IP per minute';

export const CATEGORY_DOCS = {
  // ── Storefront ──
  tree: {
    tag: CATEGORIES_TAG,
    operationId: 'getCategoryTree',
    summary: 'Category tree (all levels)',
    description:
      'Every visible category nested to any depth (`children` inside `children`), siblings in display order. `maxDepth` limits the levels returned (1 = top level only). Served from memory (no database hit); send `If-None-Match` to get **304** when nothing changed.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Nested tree (or 304 Not Modified with an empty body)',
      data: Joi.array().items(node),
      example: ok(treeExample),
      headers: TREE_ETAG,
    },
    errors: [422],
  },
  bySlug: {
    tag: CATEGORIES_TAG,
    operationId: 'getCategoryBySlug',
    summary: 'Category page: details, breadcrumbs and direct sub-categories',
    description:
      'For a category listing page. Unknown, deleted and hidden (inactive self or ancestor) categories all answer 404.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Category page',
      data: publicDetail,
      example: ok({
        category: { ...live, description: 'Freeze-dried live vaccines (cold chain 2–8 °C).' },
        breadcrumbs: [crumbOf(vaccines)],
        children: [nd, ibd],
      }),
      headers: TREE_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },
  subcategories: {
    tag: CATEGORIES_TAG,
    operationId: 'getSubcategories',
    summary: 'Sub-categories of a category',
    description:
      '`maxDepth=1` (default) = direct sub-categories; larger values return deeper levels nested under each.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Sub-category nodes',
      data: Joi.array().items(node),
      example: ok([
        { ...nd, children: [] },
        { ...ibd, children: [] },
      ]),
      headers: TREE_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },

  // ── Admin reads ──
  list: {
    tag: ADMIN_CATEGORIES_TAG,
    operationId: 'adminListCategories',
    summary: 'List categories (flat, filterable)',
    description:
      '`parentId=root` → top level; `parentId=<uuid>` → direct sub-categories of that category; omitted → all levels (ordered by depth, then sibling order). `q` searches name, Telugu name and slug. Includes inactive categories.',
    auth: AUTH_ADMIN,
    permission: 'catalogue.view',
    success: {
      status: 200,
      description: 'A page of categories',
      data: adminCategory,
      paginated: true,
      example: ok([adminExample], { nextCursor: null, limit: 20 }),
    },
    errors: [422],
  },
  adminTree: {
    tag: ADMIN_CATEGORIES_TAG,
    operationId: 'adminGetCategoryTree',
    summary: 'Full category tree including inactive nodes',
    description:
      'Every live category nested to any depth with `isActive` and `effectiveActive` (what the storefront shows). Supports `If-None-Match` → 304.',
    auth: AUTH_ADMIN,
    permission: 'catalogue.view',
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Nested admin tree',
      data: Joi.array().items(adminNode),
      example: ok([
        {
          ...vaccines,
          isActive: true,
          effectiveActive: true,
          children: [{ ...live, isActive: false, effectiveActive: false, children: [] }],
        },
      ]),
      headers: TREE_ETAG,
    },
  },
  get: {
    tag: ADMIN_CATEGORIES_TAG,
    operationId: 'adminGetCategory',
    summary: 'Category detail with ancestors and sub-categories',
    auth: AUTH_ADMIN,
    permission: 'catalogue.view',
    success: {
      status: 200,
      description: 'Category detail',
      data: adminDetail,
      example: ok({
        ...adminExample,
        ancestors: [crumbOf(vaccines)],
        children: [
          { ...nd, isActive: true },
          { ...ibd, isActive: true },
        ],
      }),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },
  history: {
    tag: ADMIN_CATEGORIES_TAG,
    operationId: 'adminCategoryHistory',
    summary: 'Change history (audit log) of a category',
    description: 'Newest first. Kept after the category is deleted.',
    auth: AUTH_ADMIN,
    permission: 'catalogue.view',
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
            action: 'category.move',
            reason: 'Grouping ND vaccines under Live Vaccines',
            createdAt: at,
          },
        ],
        { nextCursor: null, limit: 20 },
      ),
    },
    errors: [422],
  },

  // ── Admin writes ──
  create: {
    tag: ADMIN_CATEGORIES_TAG,
    operationId: 'adminCreateCategory',
    summary: 'Create a category or sub-category',
    description:
      'Omit `parentId` (or send null) for a top-level category; set it to create a sub-category at any depth (limit `CATALOG_MAX_CATEGORY_DEPTH`, default 10 levels). `slug` is generated from `name` when omitted (`live-vaccines`, `live-vaccines-2` …). New categories go last among their siblings unless `sortOrder` is given. Audited.',
    auth: AUTH_ADMIN,
    permission: 'catalogue.create',
    headers: IDEMPOTENCY_KEY,
    requestExample: {
      parentId: IDS.vaccines,
      name: 'Live Vaccines',
      nameTe: 'లైవ్ టీకాలు',
      description: 'Freeze-dried live vaccines (cold chain 2–8 °C).',
      imageUrl: 'https://cdn.farmx.in/categories/live-vaccines.webp',
      isActive: true,
      reason: 'New sub-category for the vaccine range',
    },
    success: {
      status: 201,
      description: 'Created',
      data: adminCategory,
      example: ok({ ...adminExample, version: 0 }),
      headers: VERSION_ETAG,
    },
    errors: [409, 422],
    errorExamples: {
      409: [slugTaken, nameTaken],
      422: [
        parentMissing,
        {
          summary: 'Too deep',
          message: 'Validation failed',
          details: {
            issues: [{ path: 'parentId', message: 'Categories can be at most 10 levels deep' }],
          },
        },
        reasonIssue,
      ],
    },
  },
  update: {
    tag: ADMIN_CATEGORIES_TAG,
    operationId: 'adminUpdateCategory',
    summary: 'Update a category (name, slug, image, order, active …)',
    description:
      '`reason` plus at least one field. The parent is changed with **/move**. `isActive: false` hides the category and its whole subtree from the storefront (children keep their own flag). Audited with before/after.',
    auth: AUTH_ADMIN,
    permission: 'catalogue.update',
    headers: IF_MATCH,
    requestExample: {
      name: 'Live Vaccines (Freeze-dried)',
      isActive: false,
      reason: 'Range paused for re-labelling',
    },
    success: {
      status: 200,
      description: 'Updated',
      data: adminCategory,
      example: ok({
        ...adminExample,
        name: 'Live Vaccines (Freeze-dried)',
        isActive: false,
        effectiveActive: false,
        version: 4,
      }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: notFound, 409: [versionConflict, slugTaken, nameTaken] },
  },
  move: {
    tag: ADMIN_CATEGORIES_TAG,
    operationId: 'adminMoveCategory',
    summary: 'Move a category (with its whole subtree) to a new parent',
    description:
      '`parentId: null` makes it a top-level category. The category and every descendant get their new path and depth in ONE statement. Refused (422) when the new parent is the category itself or inside its subtree, or when the branch would exceed the depth limit. Audited.',
    auth: AUTH_ADMIN,
    permission: 'catalogue.update',
    headers: IF_MATCH,
    requestExample: {
      parentId: IDS.vaccines,
      sortOrder: 30,
      reason: 'Grouping ND vaccines directly under Vaccines',
    },
    success: {
      status: 200,
      description: 'Moved',
      data: adminCategory,
      example: ok({
        ...adminExample,
        id: IDS.nd,
        parentId: IDS.vaccines,
        name: 'ND Vaccines',
        slug: 'nd-vaccines',
        path: `/${IDS.vaccines}/${IDS.nd}/`,
        depth: 1,
        sortOrder: 30,
        childCount: 0,
        version: 2,
      }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: {
      404: notFound,
      409: [versionConflict, nameTaken],
      422: [
        {
          summary: 'Cycle (under itself or a descendant)',
          message: 'Validation failed',
          details: {
            issues: [
              {
                path: 'parentId',
                message: 'A category cannot be moved under itself or one of its sub-categories',
              },
            ],
          },
        },
        parentMissing,
      ],
    },
  },
  reorder: {
    tag: ADMIN_CATEGORIES_TAG,
    operationId: 'adminReorderCategories',
    summary: 'Reorder the sub-categories of one parent (drag and drop)',
    description:
      '`orderedIds` must list every live sub-category of `parentId` (null = top level) exactly once; they get sortOrder 10, 20, 30 … in that order, in one statement. Audited.',
    auth: AUTH_ADMIN,
    permission: 'catalogue.update',
    requestExample: {
      parentId: IDS.live,
      orderedIds: [IDS.ibd, IDS.nd],
      reason: 'IBD first for the winter season',
    },
    success: {
      status: 200,
      description: 'Siblings in their new order',
      data: Joi.array().items(summary),
      example: ok([
        { ...ibd, sortOrder: 10 },
        { ...nd, sortOrder: 20 },
      ]),
    },
    errors: [422],
    errorExamples: {
      422: {
        summary: 'Not the full sibling set',
        message: 'Validation failed',
        details: {
          issues: [
            {
              path: 'orderedIds',
              message: 'must list every live sub-category of the parent exactly once (2 expected)',
            },
          ],
        },
      },
    },
  },
  remove: {
    tag: ADMIN_CATEGORIES_TAG,
    operationId: 'adminDeleteCategory',
    summary: 'Delete a category (soft delete)',
    description:
      'Only a category without live sub-categories can be deleted (move or delete them first → otherwise 409 `CATEGORY_HAS_CHILDREN`). The slug becomes free again; the audit history is kept. `reason` goes in the query string.',
    auth: AUTH_ADMIN,
    permission: 'catalogue.update',
    headers: IF_MATCH,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 409, 422],
    errorExamples: {
      404: notFound,
      409: [
        {
          summary: 'CATEGORY_HAS_CHILDREN',
          message: 'Move or delete its sub-categories first',
          details: { reason: 'CATEGORY_HAS_CHILDREN', childCount: 2 },
        },
        versionConflict,
      ],
    },
  },
} satisfies Record<string, RouteDocs>;
