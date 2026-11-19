import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, AUTH_CUSTOMER, IDS, ok, reasonIssue } from '../../docs/shared.js';

export const GEO_TAG = 'Farms · Geo';
export const ADMIN_GEO_TAG = 'Admin · Geo';

const node = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string().allow(null).example('Mother WH (Eluru)'),
})
  .allow(null)
  .meta({ className: 'ServingNode' });

const pinSchema = Joi.object({
  pinCode: Joi.string().example('534432'),
  serviceable: Joi.boolean().description('false → farm location and quick sign-up reject this pin'),
  territory: Joi.object({ id: Joi.string().guid(), code: Joi.string().example('WG') }),
  districtName: Joi.string().example('Eluru'),
  mandalName: Joi.string().allow(null).example('Denduluru'),
  villages: Joi.array().items(Joi.string()),
  primaryNode: node,
  backupNode: node,
  deliveryPromise: Joi.string().allow(null).example('Next-day delivery'),
}).meta({ className: 'PinCodeInfo' });

const territorySchema = Joi.object({
  id: Joi.string().guid(),
  code: Joi.string().description('2–3 uppercase letters; part of every Farm ID').example('WG'),
  name: Joi.string().example('West Godavari'),
  districtName: Joi.string().example('Eluru'),
  stateCode: Joi.string().example('AP'),
  isActive: Joi.boolean(),
}).meta({ className: 'Territory' });

const pinExample = {
  pinCode: '534432',
  serviceable: true,
  territory: { id: IDS.territory, code: 'WG' },
  districtName: 'Eluru',
  mandalName: 'Denduluru',
  villages: ['Denduluru', 'Kovvali'],
  primaryNode: { id: IDS.node, name: 'Mother WH (Eluru)' },
  backupNode: { id: IDS.node2, name: 'Tanuku C&F' },
  deliveryPromise: 'Next-day delivery',
};

const territoryExample = {
  id: IDS.territory,
  code: 'WG',
  name: 'West Godavari',
  districtName: 'Eluru',
  stateCode: 'AP',
  isActive: true,
};

export const GEO_DOCS = {
  lookupPin: {
    tag: GEO_TAG,
    operationId: 'lookupPinCode',
    summary: 'Resolve a pin code (Farm Location step)',
    description:
      'District, mandal, villages, territory, serving nodes and delivery promise. Known but non-serviceable pins are returned with `serviceable: false`; unknown pins → 404. In-process LRU + Redis (24 h), p95 < 50 ms.',
    auth: AUTH_CUSTOMER,
    rateLimit: '60 per user per minute',
    success: {
      status: 200,
      description: 'Pin code info',
      data: pinSchema,
      example: ok(pinExample),
    },
    errors: [404, 422],
    errorExamples: {
      404: { message: 'Pin code not found' },
      422: {
        summary: 'Not a 6-digit pin',
        message: 'Validation failed',
        details: { issues: [{ path: 'params.pin', message: '"pin" must be a 6-digit pin code' }] },
      },
    },
  },
  listPins: {
    tag: ADMIN_GEO_TAG,
    operationId: 'adminListPinCodes',
    summary: 'List pin codes',
    description: 'Ordered by pin code; `cursor` = the last pin code of the previous page.',
    auth: AUTH_ADMIN,
    permission: 'territories.manage',
    success: {
      status: 200,
      description: 'A page of pin codes',
      data: pinSchema,
      paginated: true,
      example: ok([pinExample], { nextCursor: '534432', limit: 20 }),
    },
    errors: [422],
  },
  upsertPin: {
    tag: ADMIN_GEO_TAG,
    operationId: 'adminUpsertPinCode',
    summary: 'Create or update a pin code mapping',
    description:
      'Full replace of the mapping for `{pin}`. `territoryCode` must exist (else 422). Audited (`reason` required); pin caches are invalidated, so changes are live at once.',
    auth: AUTH_ADMIN,
    permission: 'territories.manage',
    requestExample: {
      territoryCode: 'WG',
      districtName: 'Eluru',
      mandalName: 'Denduluru',
      villages: ['Denduluru', 'Kovvali'],
      primaryNodeId: IDS.node,
      primaryNodeName: 'Mother WH (Eluru)',
      backupNodeId: IDS.node2,
      backupNodeName: 'Tanuku C&F',
      deliveryPromise: 'Next-day delivery',
      serviceable: true,
      reason: 'Tanuku depot now serves Denduluru mandal',
    },
    success: {
      status: 200,
      description: 'Saved mapping',
      data: pinSchema,
      example: ok(pinExample),
    },
    errors: [422],
    errorExamples: {
      422: [
        {
          summary: 'Unknown territory',
          message: 'Validation failed',
          details: { issues: [{ path: 'territoryCode', message: 'Unknown territory' }] },
        },
        reasonIssue,
      ],
    },
  },
  listTerritories: {
    tag: ADMIN_GEO_TAG,
    operationId: 'adminListTerritories',
    summary: 'List territories',
    description: 'All territories, active and inactive (small master; not paginated).',
    auth: AUTH_ADMIN,
    permission: 'territories.manage',
    success: {
      status: 200,
      description: 'All territories',
      data: Joi.array().items(territorySchema),
      example: ok([territoryExample]),
    },
  },
  createTerritory: {
    tag: ADMIN_GEO_TAG,
    operationId: 'adminCreateTerritory',
    summary: 'Create a territory',
    description:
      '`code` (2–3 letters, upper-cased) is unique and permanent: it is part of every Farm ID issued in the territory. Audited.',
    auth: AUTH_ADMIN,
    permission: 'territories.manage',
    requestExample: {
      code: 'WG',
      name: 'West Godavari',
      districtName: 'Eluru',
      stateCode: 'AP',
      isActive: true,
      reason: 'Launching the West Godavari cluster',
    },
    success: {
      status: 201,
      description: 'Created',
      data: territorySchema,
      example: ok(territoryExample),
    },
    errors: [409, 422],
    errorExamples: {
      409: {
        summary: 'Code already exists',
        message: 'code already exists',
        details: { fields: ['code'] },
      },
    },
  },
  updateTerritory: {
    tag: ADMIN_GEO_TAG,
    operationId: 'adminUpdateTerritory',
    summary: 'Update a territory (code is immutable)',
    description: '`reason` plus at least one of name, districtName, stateCode, isActive. Audited.',
    auth: AUTH_ADMIN,
    permission: 'territories.manage',
    requestExample: { isActive: false, reason: 'Cluster paused for the monsoon season' },
    success: {
      status: 200,
      description: 'Updated',
      data: territorySchema,
      example: ok({ ...territoryExample, isActive: false }),
    },
    errors: [404, 422],
    errorExamples: { 404: { message: 'Territory not found' } },
  },
} satisfies Record<string, RouteDocs>;
