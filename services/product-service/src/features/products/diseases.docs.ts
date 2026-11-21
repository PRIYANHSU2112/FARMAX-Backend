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

export const DISEASES_TAG = 'Catalog · Shop by Problem';
export const ADMIN_DISEASES_TAG = 'Admin · Diseases';

const PERMISSION = 'catalogue.manage';
const at = '2026-11-30T09:30:00.000Z';
const diseaseId = '0193a1b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';

const publicDisease = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string().example('Coccidiosis'),
  slug: Joi.string().example('coccidiosis'),
  description: Joi.string().allow(null),
  iconUrl: Joi.string().allow(null),
  productCount: Joi.number()
    .integer()
    .description('Storefront-visible products only (published, active, visible category/brand)'),
}).meta({ className: 'DiseaseCard' });

const adminDisease = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string(),
  slug: Joi.string(),
  description: Joi.string().allow(null),
  iconUrl: Joi.string().allow(null),
  iconMediaId: Joi.string().guid().allow(null),
  sortOrder: Joi.number().integer(),
  isActive: Joi.boolean(),
  version: Joi.number().integer(),
  createdByUserId: Joi.string().guid(),
  updatedByUserId: Joi.string().guid(),
  createdAt: Joi.date(),
  updatedAt: Joi.date(),
}).meta({ className: 'AdminDisease' });

const card = {
  id: diseaseId,
  name: 'Coccidiosis',
  slug: 'coccidiosis',
  description: 'Bloody droppings, poor growth',
  iconUrl: 'https://cdn.farmx.in/icons/coccidiosis.png',
  productCount: 14,
};
const adminExample = {
  id: diseaseId,
  name: 'Coccidiosis',
  slug: 'coccidiosis',
  description: 'Bloody droppings, poor growth',
  iconUrl: 'https://cdn.farmx.in/icons/coccidiosis.png',
  iconMediaId: null,
  sortOrder: 10,
  isActive: true,
  version: 0,
  createdByUserId: IDS.admin,
  updatedByUserId: IDS.admin,
  createdAt: at,
  updatedAt: at,
};

const notFound = { message: 'Disease not found' };

export const DISEASE_DOCS = {
  publicList: {
    tag: DISEASES_TAG,
    operationId: 'listDiseases',
    summary: '"Shop by Problem" cards for the home screen',
    description:
      'Active diseases in admin order with the number of storefront-visible products. `hideEmpty=true` drops cards with no product. Tap a card → `GET /v1/catalog/products?diseaseSlug=<slug>`. Cached 60 s and expired by any product / disease change; supports `If-None-Match` → 304.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Disease cards',
      data: Joi.array().items(publicDisease),
      example: ok([card]),
      headers: PUBLIC_ETAG,
    },
    errors: [422],
  },
  list: {
    tag: ADMIN_DISEASES_TAG,
    operationId: 'adminListDiseases',
    summary: 'List diseases (including inactive)',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    success: {
      status: 200,
      description: 'Diseases',
      data: Joi.array().items(adminDisease),
      example: ok([adminExample]),
    },
    errors: [422],
  },
  get: {
    tag: ADMIN_DISEASES_TAG,
    operationId: 'adminGetDisease',
    summary: 'Disease detail',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    success: {
      status: 200,
      description: 'Disease',
      data: adminDisease,
      example: ok(adminExample),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },
  create: {
    tag: ADMIN_DISEASES_TAG,
    operationId: 'adminCreateDisease',
    summary: 'Add a disease / problem',
    description:
      'Name and slug are unique among live diseases (a deleted disease frees its slug). Slug is generated from the name when omitted. Audited.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    requestExample: {
      name: 'Coccidiosis',
      description: 'Bloody droppings, poor growth',
      iconUrl: 'https://cdn.farmx.in/icons/coccidiosis.png',
      sortOrder: 10,
      reason: 'Home screen Shop by Problem launch',
    },
    success: {
      status: 201,
      description: 'Created',
      data: adminDisease,
      example: ok(adminExample),
      headers: VERSION_ETAG,
    },
    errors: [409, 422],
    errorExamples: {
      409: {
        summary: 'SLUG_TAKEN',
        message: 'Slug "coccidiosis" is already used by another disease',
        details: { reason: 'SLUG_TAKEN', fields: ['slug'] },
      },
      422: reasonIssue,
    },
  },
  update: {
    tag: ADMIN_DISEASES_TAG,
    operationId: 'adminUpdateDisease',
    summary: 'Edit, reorder or (de)activate a disease',
    description:
      '`isActive: false` hides the card and the filter; links stay. Product pages showing it are refreshed. Audited.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IF_MATCH,
    requestExample: { sortOrder: 5, reason: 'Move to the first card for the monsoon' },
    success: {
      status: 200,
      description: 'Updated',
      data: adminDisease,
      example: ok({ ...adminExample, sortOrder: 5, version: 1 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: notFound },
  },
  remove: {
    tag: ADMIN_DISEASES_TAG,
    operationId: 'adminDeleteDisease',
    summary: 'Soft-delete a disease',
    description:
      'Refused with 409 `DISEASE_IN_USE` while any active product is linked (deactivate instead). The row and its links to inactive / deleted products are kept as history; the slug becomes reusable.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IF_MATCH,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 409, 422],
    errorExamples: {
      404: notFound,
      409: {
        summary: 'DISEASE_IN_USE',
        message:
          'This disease is linked to active products; unlink them or deactivate the disease instead',
        details: { reason: 'DISEASE_IN_USE', productCount: 3 },
      },
    },
  },
} satisfies Record<string, RouteDocs>;
