import Joi from 'joi';

import { ID, PAGE, RES_CODE, VERSION } from '../../middleware/http.js';
import { TEMP_CLASSES } from '../warehouses/index.js';
import { MAX_BINS_PER_CALL } from './storage.service.js';

export const RESOURCE_STATUSES = ['ACTIVE', 'INACTIVE', 'MAINTENANCE'] as const;

const STATUS = Joi.string().valid(...RESOURCE_STATUSES);
const WEIGHT = Joi.number().positive().max(10_000_000).precision(2);
const VOLUME = Joi.number().positive().max(1_000_000).precision(3);
const TEMP = Joi.number().min(-60).max(60).precision(1).allow(null);
const LIMITS = { maxWeightKg: WEIGHT.required(), volumeM3: VOLUME.required() };

const wh = { id: ID.required() };
const zoneFields = {
  name: Joi.string().trim().min(1).max(80),
  temperatureClass: Joi.string().valid(...TEMP_CLASSES),
  minTempC: TEMP,
  maxTempC: TEMP,
  isFoodGrade: Joi.boolean(),
  productCategoryIds: Joi.array().items(ID).max(50).unique(),
  status: STATUS,
  sortOrder: Joi.number().integer().min(0).max(10_000),
};

export const layoutSchema = { params: Joi.object(wh) };
export const listZonesSchema = layoutSchema;

export const createZoneSchema = {
  params: Joi.object(wh),
  body: Joi.object({
    ...zoneFields,
    code: RES_CODE.required(),
    name: zoneFields.name.required(),
    temperatureClass: zoneFields.temperatureClass.required(),
  }),
};

export const updateZoneSchema = {
  params: Joi.object({ ...wh, zoneId: ID.required() }),
  body: Joi.object({ ...zoneFields, expectedVersion: VERSION.required() })
    .or(...Object.keys(zoneFields))
    .messages({ 'object.missing': 'change at least one field' }),
};

export const zoneParamsSchema = { params: Joi.object({ ...wh, zoneId: ID.required() }) };

export const listRacksSchema = {
  params: Joi.object(wh),
  querystring: Joi.object({ zoneId: ID }),
};

export const createRackSchema = {
  params: Joi.object({ ...wh, zoneId: ID.required() }),
  body: Joi.object({
    code: RES_CODE.description('Omitted = next free <zone>-NN'),
    ...LIMITS,
    status: STATUS,
    generateBins: Joi.object({
      count: Joi.number().integer().min(1).max(MAX_BINS_PER_CALL).required(),
      ...LIMITS,
    }).description('Also create N auto-coded bins with these limits'),
  }),
};

export const updateRackSchema = {
  params: Joi.object({ ...wh, rackId: ID.required() }),
  body: Joi.object({
    expectedVersion: VERSION.required(),
    maxWeightKg: WEIGHT,
    volumeM3: VOLUME,
    status: STATUS,
  }).or('maxWeightKg', 'volumeM3', 'status'),
};

export const rackParamsSchema = { params: Joi.object({ ...wh, rackId: ID.required() }) };

export const listBinsSchema = {
  params: Joi.object(wh),
  querystring: Joi.object({
    rackId: ID,
    zoneId: ID,
    cursor: Joi.string().max(24).description('The last bin code of the previous page'),
    limit: PAGE.limit,
  }),
};

export const createBinsSchema = {
  params: Joi.object({ ...wh, rackId: ID.required() }),
  body: Joi.object({
    bins: Joi.array()
      .items(Joi.object({ code: RES_CODE, ...LIMITS }))
      .min(1)
      .max(MAX_BINS_PER_CALL),
    count: Joi.number().integer().min(1).max(MAX_BINS_PER_CALL),
    maxWeightKg: WEIGHT,
    volumeM3: VOLUME,
  })
    .xor('bins', 'count')
    .with('count', ['maxWeightKg', 'volumeM3'])
    .messages({ 'object.xor': 'send either bins or count (+ maxWeightKg, volumeM3)' }),
};

export const updateBinSchema = {
  params: Joi.object({ ...wh, binId: ID.required() }),
  body: Joi.object({ maxWeightKg: WEIGHT, volumeM3: VOLUME, status: STATUS }).or(
    'maxWeightKg',
    'volumeM3',
    'status',
  ),
};

export const binParamsSchema = { params: Joi.object({ ...wh, binId: ID.required() }) };
