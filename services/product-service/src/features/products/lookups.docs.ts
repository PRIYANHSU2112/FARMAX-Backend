import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import {
  AUTH_ADMIN,
  AUTH_PUBLIC,
  IDS,
  IF_MATCH,
  IF_NONE_MATCH,
  PUBLIC_ETAG,
  PUBLIC_RATE,
  VERSION_ETAG,
  ok,
  reasonIssue,
} from '../../docs/shared.js';

export const LOOKUPS_TAG = 'Catalog · Product Lookups';
export const ADMIN_LOOKUPS_TAG = 'Admin · Product Lookups';

const PERMISSION = 'catalogue.manage';
const at = '2026-11-14T09:30:00.000Z';

const publicLookup = Joi.object({
  id: Joi.string().guid(),
  group: Joi.string().valid('DOSAGE_FORM', 'ROUTE', 'SPECIES', 'UNIT', 'FLOCK_STAGE'),
  code: Joi.string().example('BROILER'),
  label: Joi.string().example('Broiler'),
  meta: Joi.object()
    .unknown()
    .description(
      'SPECIES: `producesMeat`, `producesEggs` (drive withdrawal-period rules). FLOCK_STAGE: `aliases` (legacy text mapped to the code)',
    ),
}).meta({ className: 'ProductLookup' });

const adminLookup = Joi.object({
  id: Joi.string().guid(),
  group: Joi.string(),
  code: Joi.string(),
  label: Joi.string(),
  description: Joi.string().allow(null),
  meta: Joi.object().unknown(),
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer(),
  version: Joi.number().integer(),
  createdByUserId: Joi.string().guid(),
  updatedByUserId: Joi.string().guid(),
  createdAt: Joi.date(),
  updatedAt: Joi.date(),
}).meta({ className: 'AdminProductLookup' });

const broiler = {
  id: IDS.lookup,
  group: 'SPECIES',
  code: 'BROILER',
  label: 'Broiler',
  meta: { producesMeat: true, producesEggs: false },
};
const adminExample = {
  ...broiler,
  description: null,
  isActive: true,
  sortOrder: 10,
  version: 0,
  createdByUserId: IDS.admin,
  updatedByUserId: IDS.admin,
  createdAt: at,
  updatedAt: at,
};

const notFound = { message: 'Lookup not found' };

export const LOOKUP_DOCS = {
  publicList: {
    tag: LOOKUPS_TAG,
    operationId: 'listProductLookups',
    summary: 'Active master values (dosage forms, routes, species, units, flock stages)',
    description:
      'Drives filter chips and labels on the storefront. `group` narrows to one list. Cached; supports `If-None-Match` → 304.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Lookup values in display order',
      data: Joi.array().items(publicLookup),
      example: ok([
        broiler,
        {
          ...broiler,
          id: IDS.attribute,
          code: 'LAYER',
          label: 'Layer',
          meta: { producesMeat: true, producesEggs: true },
        },
      ]),
      headers: PUBLIC_ETAG,
    },
    errors: [422],
  },
  list: {
    tag: ADMIN_LOOKUPS_TAG,
    operationId: 'adminListProductLookups',
    summary: 'List master values (including inactive)',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    success: {
      status: 200,
      description: 'Lookup values',
      data: Joi.array().items(adminLookup),
      example: ok([adminExample]),
    },
    errors: [422],
  },
  get: {
    tag: ADMIN_LOOKUPS_TAG,
    operationId: 'adminGetProductLookup',
    summary: 'Master value detail',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    success: {
      status: 200,
      description: 'Lookup value',
      data: adminLookup,
      example: ok(adminExample),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },
  create: {
    tag: ADMIN_LOOKUPS_TAG,
    operationId: 'adminCreateProductLookup',
    summary: 'Add a master value',
    description:
      '`code` is stored upper-case and is unique within its group. For SPECIES set `meta.producesMeat` / `meta.producesEggs`. Audited.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    requestExample: {
      group: 'SPECIES',
      code: 'turkey',
      label: 'Turkey',
      meta: { producesMeat: true, producesEggs: false },
      sortOrder: 80,
      reason: 'Adding turkey for the new product range',
    },
    success: {
      status: 201,
      description: 'Created',
      data: adminLookup,
      example: ok({ ...adminExample, code: 'TURKEY', label: 'Turkey' }),
      headers: VERSION_ETAG,
    },
    errors: [409, 422],
    errorExamples: {
      409: {
        summary: 'LOOKUP_DUPLICATE',
        message: 'SPECIES code TURKEY already exists',
        details: { reason: 'LOOKUP_DUPLICATE', fields: ['code'] },
      },
      422: reasonIssue,
    },
  },
  update: {
    tag: ADMIN_LOOKUPS_TAG,
    operationId: 'adminUpdateProductLookup',
    summary: 'Edit or (de)activate a master value',
    description:
      'Group and code are immutable. `isActive: false` hides it from new products; existing products keep it. Audited.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IF_MATCH,
    requestExample: { label: 'Broiler (meat bird)', reason: 'Clearer storefront label' },
    success: {
      status: 200,
      description: 'Updated',
      data: adminLookup,
      example: ok({ ...adminExample, label: 'Broiler (meat bird)', version: 1 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: notFound },
  },
  remove: {
    tag: ADMIN_LOOKUPS_TAG,
    operationId: 'adminDeleteProductLookup',
    summary: 'Delete an unused master value',
    description:
      'A value used by any product, ingredient or variant → 409 `LOOKUP_IN_USE`; deactivate it instead.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IF_MATCH,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 409, 422],
    errorExamples: {
      404: notFound,
      409: {
        summary: 'LOOKUP_IN_USE',
        message: 'This value is in use; deactivate it instead',
        details: { reason: 'LOOKUP_IN_USE', count: 12 },
      },
    },
  },
} satisfies Record<string, RouteDocs>;
