import Joi from 'joi';

import { ID, REASON } from '../../middleware/http.js';
import { PAGING } from '../../middleware/paging.js';

const TEMP = Joi.string().valid('AMB', 'AMB_CTL', 'CC_REF', 'CC_FRZ', 'HAZ');
const FILTER = {
  warehouseId: ID,
  categoryId: ID,
  temperatureClass: TEMP,
};

export const kpisQuery = { querystring: Joi.object({ ...FILTER, fresh: Joi.boolean() }) };
export const categoriesQuery = { querystring: Joi.object({ warehouseId: ID }) };

const ITEMS = {
  ...FILTER,
  q: Joi.string().trim().min(1).max(60),
  health: Joi.string().valid('HEALTHY', 'HIGH_DEMAND', 'LOW_BUFFER', 'THROTTLED', 'OUT'),
};
export const itemsQuery = {
  querystring: Joi.object({
    ...ITEMS,
    sort: Joi.string().valid('netAtp', 'physical', 'projected', 'demand', 'name').default('netAtp'),
    order: Joi.string().valid('asc', 'desc').default('asc'),
    ...PAGING,
  }).oxor('cursor', 'page'),
};
export const exportQuery = { querystring: Joi.object(ITEMS) };

export const settingsSchema = {
  body: Joi.object({
    healthBands: Joi.object({
      healthy: Joi.number().integer().min(1).max(100).required(),
      low: Joi.number().integer().min(0).max(99).required(),
    }).custom((v: { healthy: number; low: number }, h) =>
      v.low < v.healthy ? v : h.message({ custom: '"low" must be below "healthy"' }),
    ),
    storefrontChannels: Joi.array()
      .items(Joi.string().trim().uppercase().max(30))
      .min(1)
      .max(10)
      .unique(),
    guardrailsEnabled: Joi.boolean(),
    bufferFloorPct: Joi.number().integer().min(0).max(100),
    cartHoldLeaseSeconds: Joi.number().integer().min(60).max(3_600),
    reason: REASON.required(),
  }).or(
    'healthBands',
    'storefrontChannels',
    'guardrailsEnabled',
    'bufferFloorPct',
    'cartHoldLeaseSeconds',
  ),
};

export const syncSchema = {
  body: Joi.object({ warehouseId: ID.allow(null) })
    .empty(null)
    .default({}),
};
