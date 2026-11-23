import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_STAFF, IDS, ok } from '../../docs/shared.js';

export const WMS_PORTAL_TAG = 'Warehouse Portal';

export const PORTAL_DOCS = {
  me: {
    tag: WMS_PORTAL_TAG,
    summary: 'Who am I (after login)',
    description:
      'Profile, the warehouses the user may open with their permissions at each (warehouse switcher, sidebar), the default warehouse and which modules have a backend. An empty `warehouses` list = show "No warehouse access yet". Any signed-in staff user.',
    auth: 'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done).',
    success: {
      status: 200,
      description: 'Portal context',
      data: Joi.object({
        user: Joi.object({
          id: Joi.string().guid(),
          fullName: Joi.string().allow(null),
          email: Joi.string().allow(null),
          initials: Joi.string().allow(null),
          roles: Joi.array().items(Joi.string()),
        }),
        canSeeAll: Joi.boolean().description('GLOBAL viewer: show "All warehouses"'),
        warehouses: Joi.array().items(
          Joi.object({
            id: Joi.string().guid(),
            code: Joi.string(),
            name: Joi.string(),
            type: Joi.string(),
            status: Joi.string(),
            city: Joi.string(),
            stateName: Joi.string().allow(null),
            permissions: Joi.array().items(Joi.string()),
          }),
        ),
        defaultWarehouseId: Joi.string().guid().allow(null),
        modules: Joi.object().pattern(Joi.string(), Joi.boolean()),
      }).meta({ className: 'WmsMe' }),
      example: ok({
        user: {
          id: IDS.manager,
          fullName: 'Aisha Khan',
          email: 'aisha@farmx.in',
          initials: 'AK',
          roles: ['warehouse_manager'],
        },
        canSeeAll: false,
        warehouses: [
          {
            id: IDS.warehouse,
            code: 'MW-ELR-01',
            name: 'Mother WH - Eluru',
            type: 'MOTHER',
            status: 'ACTIVE',
            city: 'Eluru',
            stateName: 'Andhra Pradesh',
            permissions: ['warehouse.configure', 'warehouse.view'],
          },
        ],
        defaultWarehouseId: IDS.warehouse,
        modules: { multiWarehouse: true, serviceAreas: true, storage: false },
      }),
    },
  },
  search: {
    tag: WMS_PORTAL_TAG,
    summary: 'Header search',
    description:
      'Warehouses by code, name or city; a 6-digit query also lists who serves that PIN. Batches, bins, orders and vehicles join as their modules ship. Only warehouses the caller may see.',
    auth: AUTH_STAFF,
    permission: 'warehouse.view',
    success: {
      status: 200,
      description: 'Results',
      data: Joi.array().items(
        Joi.object({
          type: Joi.string().valid('warehouse', 'pin'),
          id: Joi.string(),
          title: Joi.string(),
          subtitle: Joi.string(),
          warehouseId: Joi.string().guid(),
        }).meta({ className: 'WmsSearchResult' }),
      ),
    },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
