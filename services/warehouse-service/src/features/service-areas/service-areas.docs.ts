import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_STAFF, IDS, ok } from '../../docs/shared.js';
import { AREA_PRIORITIES } from './service-areas.types.js';

export const ADMIN_SERVICE_AREAS_TAG = 'Admin Warehouse Service Areas';

const VERSION_NOTE =
  '`expectedVersion` = the `coverageVersion` from the last read; a stale value → 409 `VERSION_CONFLICT`. Every write publishes the complete PIN coverage to inventory (allocation).';

const area = Joi.object({
  id: Joi.string().guid(),
  kind: Joi.string()
    .valid('DISTRICT', 'IMPORTED')
    .description('IMPORTED = PINs copied from inventory with no district yet'),
  stateCode: Joi.string().allow(null).example('27'),
  stateName: Joi.string().allow(null).example('Maharashtra'),
  district: Joi.string().allow(null).example('Pune'),
  priority: Joi.string()
    .valid(...AREA_PRIORITIES)
    .allow(null),
  pinCount: Joi.number().integer().example(56),
  firstPin: Joi.string().allow(null).example('411001'),
  lastPin: Joi.string().allow(null).example('411056'),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'ServiceArea' });

const areasView = Joi.object({
  warehouseId: Joi.string().guid(),
  coverageVersion: Joi.number().integer(),
  summary: Joi.object({
    districts: Joi.number().integer(),
    pinCodes: Joi.number().integer(),
    unassignedPins: Joi.number()
      .integer()
      .description('Imported PINs not yet in a district: show the "Move to district" banner'),
    defaultPriority: Joi.string()
      .valid(...AREA_PRIORITIES)
      .allow(null),
  }),
  areas: Joi.array().items(area),
}).meta({ className: 'ServiceAreas' });

const example = {
  warehouseId: IDS.warehouse,
  coverageVersion: 3,
  summary: { districts: 3, pinCodes: 128, unassignedPins: 0, defaultPriority: 'HIGH' },
  areas: [
    {
      id: IDS.area,
      kind: 'DISTRICT',
      stateCode: '27',
      stateName: 'Maharashtra',
      district: 'Pune',
      priority: 'HIGH',
      pinCount: 56,
      firstPin: '411001',
      lastPin: '411056',
      updatedAt: '2026-11-23T06:00:00.000Z',
    },
  ],
};

const view = {
  status: 200 as const,
  description: 'The service areas after the change',
  data: areasView,
  example: ok(example),
};

export const SERVICE_AREA_DOCS = {
  list: {
    tag: ADMIN_SERVICE_AREAS_TAG,
    summary: 'Service areas (W2.04, wizard step 2)',
    description:
      'KPIs (districts, PIN codes, default priority, unassigned imported PINs) and one row per area. The map view colours districts by `priority`; district boundaries are a frontend asset.',
    auth: AUTH_STAFF,
    permission: 'warehouse.view',
    success: { ...view, description: 'Service areas' },
    errors: [404, 422],
  },
  get: {
    tag: ADMIN_SERVICE_AREAS_TAG,
    summary: 'One area with its PINs (edit form)',
    auth: AUTH_STAFF,
    permission: 'warehouse.view',
    success: {
      status: 200,
      description: 'The area',
      data: area.keys({
        pins: Joi.array().items(Joi.string()),
        ranges: Joi.array().items(Joi.string()).description('Compact form, e.g. 411001-411045'),
      }),
    },
    errors: [404, 422],
  },
  create: {
    tag: ADMIN_SERVICE_AREAS_TAG,
    summary: 'Assign a district',
    description: `District + PINs and/or ranges (each range within one PIN area, ≤ 1,000 PINs; ≤ 5,000 PINs per warehouse) + priority (HIGH 10 · MEDIUM 50 · LOW 90 allocation rank). 409 \`DISTRICT_EXISTS\` or \`PIN_TAKEN\` (a PIN belongs to one area per warehouse). ${VERSION_NOTE}`,
    auth: AUTH_STAFF,
    permission: 'warehouse.configure',
    requestExample: {
      expectedVersion: 3,
      stateCode: '27',
      district: 'Nashik',
      priority: 'MEDIUM',
      pins: ['422001-422032'],
    },
    success: { ...view, status: 201 as const },
    errors: [404, 409, 422],
  },
  update: {
    tag: ADMIN_SERVICE_AREAS_TAG,
    summary: 'Edit an area',
    description: `Change the district, the priority (re-ranks its PINs) or add / remove PINs. An area left without PINs is removed. ${VERSION_NOTE}`,
    auth: AUTH_STAFF,
    permission: 'warehouse.configure',
    success: view,
    errors: [400, 404, 409, 422],
  },
  remove: {
    tag: ADMIN_SERVICE_AREAS_TAG,
    summary: 'Delete an area',
    description: `Its PINs stop being served by this warehouse. ${VERSION_NOTE}`,
    auth: AUTH_STAFF,
    permission: 'warehouse.configure',
    success: view,
    errors: [404, 409, 422],
  },
  removeMany: {
    tag: ADMIN_SERVICE_AREAS_TAG,
    summary: 'Delete several areas (bulk)',
    description: `\`ids\` = comma-separated area ids (≤ 50). ${VERSION_NOTE}`,
    auth: AUTH_STAFF,
    permission: 'warehouse.configure',
    success: view,
    errors: [404, 409, 422],
  },
  reassign: {
    tag: ADMIN_SERVICE_AREAS_TAG,
    summary: 'Move imported PINs to a district',
    description: `Imported PINs (copied from inventory with no district) keep their exact old routing rank until this explicit, audited move. Moves the listed PINs (or \`all: true\`) into the district's area (created if needed) with the district's rank. ${VERSION_NOTE}`,
    auth: AUTH_STAFF,
    permission: 'warehouse.configure',
    success: view,
    errors: [400, 404, 409, 422],
  },
  coverage: {
    tag: ADMIN_SERVICE_AREAS_TAG,
    summary: 'Who serves a PIN (routing preview)',
    description:
      'Warehouses serving the PIN in allocation order (PIN rank, then warehouse priority, then code). `routable` = ACTIVE and allocatable now. Only warehouses the caller may see.',
    auth: AUTH_STAFF,
    permission: 'warehouse.view',
    success: {
      status: 200,
      description: 'Candidates, best first',
      data: Joi.array().items(
        Joi.object({
          warehouseId: Joi.string().guid(),
          code: Joi.string(),
          name: Joi.string(),
          type: Joi.string(),
          status: Joi.string(),
          priorityRank: Joi.number().integer(),
          warehousePriority: Joi.number().integer(),
          routable: Joi.boolean(),
        }).meta({ className: 'CoverageCandidate' }),
      ),
    },
    errors: [422],
  },
  lookups: {
    tag: ADMIN_SERVICE_AREAS_TAG,
    summary: 'Form lookups',
    description:
      'States (GST codes), temperature classes with ranges, warehouse types / statuses and area priorities, for the Add Warehouse and Service Area forms.',
    auth: AUTH_STAFF,
    permission: 'warehouse.view',
    success: { status: 200, description: 'Lookups' },
  },
  districts: {
    tag: ADMIN_SERVICE_AREAS_TAG,
    summary: 'District suggestions for a state',
    description:
      'Districts already used in the state (service areas and warehouse addresses). The form also accepts a new district name (there is no official district master in FarmX yet).',
    auth: AUTH_STAFF,
    permission: 'warehouse.view',
    success: {
      status: 200,
      description: 'District names',
      data: Joi.array().items(Joi.string()),
      example: ok(['Nashik', 'Pune']),
    },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
