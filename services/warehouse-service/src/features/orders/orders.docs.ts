import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { staffDoc } from '../../docs/shared.js';

export const ADMIN_ORDERS_TAG = 'Admin Warehouse Orders';

const order = Joi.object({
  orderId: Joi.string().guid(),
  orderNo: Joi.string().allow(null).example('FX-2611-000123'),
  shipToName: Joi.string().allow(null).example('Sri Lakshmi Poultry Farm'),
  district: Joi.string().allow(null).example('Eluru'),
  pinCode: Joi.string().allow(null).example('534001'),
  lineCount: Joi.number().integer().description('Variants held at this warehouse'),
  unitCount: Joi.number().integer(),
  status: Joi.string().valid('NEW', 'ALLOCATED', 'DELIVERED', 'CANCELLED'),
  placedAt: Joi.date().iso().allow(null),
  paidAt: Joi.date().iso(),
  confirmedAt: Joi.date().iso().allow(null),
  deliveredAt: Joi.date().iso().allow(null),
  cancelledAt: Joi.date().iso().allow(null),
}).meta({ className: 'WarehouseOrder' });

export const ORDER_DOCS = {
  list: staffDoc(ADMIN_ORDERS_TAG, 'Active orders of a warehouse (W2.03 tab)', 'warehouse.view', {
    data: Joi.array().items(order),
    paginated: true,
    description:
      'Orders whose stock this warehouse holds, newest first. NEW = paid, waiting for admin confirmation; ALLOCATED = confirmed, to pick / pack / dispatch. A split order appears at each warehouse with its own lines. Picking / packing stages arrive with W9 / W11.',
  }),
} satisfies Record<string, RouteDocs>;
