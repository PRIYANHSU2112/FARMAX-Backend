import Joi from 'joi';

import {
  DISTRICT,
  ID,
  PAGE,
  PIN_CODE,
  REASON,
  STATE_CODE,
  VERSION,
  idParams,
} from '../../middleware/http.js';
import {
  REVIEWABLE_FIELDS,
  TEMP_CLASSES,
  WAREHOUSE_STATUSES,
  WAREHOUSE_TYPES,
} from './warehouses.types.js';

/** Same rule as the database CHECK and inventory's copy. */
export const CODE = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z0-9][A-Z0-9_-]{1,19}$/)
  .messages({ 'string.pattern.base': 'must be 2–20 letters, digits, "-" or "_"' });

/** 10-digit Indian mobile, optionally with +91 (stored as +91…). */
const PHONE = Joi.string()
  .trim()
  .pattern(/^(\+91)?[6-9]\d{9}$/)
  .messages({ 'string.pattern.base': 'must be a 10-digit mobile number' });

const CAPACITY = Joi.object({
  value: Joi.number().positive().max(1_000_000_000).required(),
  unit: Joi.string().valid('KG', 'TONNES').default('KG'),
}).description('Storage capacity; stored in kg');

const fields = {
  name: Joi.string().trim().min(3).max(120),
  type: Joi.string().valid(...WAREHOUSE_TYPES),
  parentWarehouseId: ID.allow(null).description(
    'Depots only: the live central warehouse (default when omitted)',
  ),
  managerUserId: ID.allow(null).description('A staff user (auth-service)'),
  phone: PHONE.allow(null),
  email: Joi.string().trim().lowercase().email().max(254).allow(null),
  addressLine: Joi.string().trim().min(5).max(250),
  landmark: Joi.string().trim().max(120).allow(null, ''),
  city: Joi.string().trim().min(2).max(80),
  stateCode: STATE_CODE,
  pinCode: PIN_CODE,
  latitude: Joi.number().min(-90).max(90).precision(6).allow(null),
  longitude: Joi.number().min(-180).max(180).precision(6).allow(null),
  tagline: Joi.string().trim().max(80).allow(null, ''),
  totalAreaSqft: Joi.number().integer().min(1).max(100_000_000).allow(null),
  capacity: CAPACITY.allow(null),
  temperatureClasses: Joi.array()
    .items(Joi.string().valid(...TEMP_CLASSES))
    .min(1)
    .unique(),
  isAllocatable: Joi.boolean(),
  priority: Joi.number().integer().min(1).max(10_000),
};

const listFilters = {
  q: Joi.string().trim().min(1).max(60).description('Code, name or city'),
  type: Joi.string().valid(...WAREHOUSE_TYPES),
  status: Joi.string().valid(...WAREHOUSE_STATUSES),
  stateCode: STATE_CODE,
  city: Joi.string().trim().min(2).max(80),
};

export const listWarehousesSchema = { querystring: Joi.object({ ...PAGE, ...listFilters }) };
export const exportWarehousesSchema = { querystring: Joi.object(listFilters) };
export const codeAvailabilitySchema = { querystring: Joi.object({ code: CODE.required() }) };
export const getWarehouseSchema = idParams;

export const createWarehouseSchema = {
  body: Joi.object({
    ...fields,
    code: CODE.required(),
    name: fields.name.required(),
    type: fields.type.required(),
    addressLine: fields.addressLine.required(),
    city: fields.city.required(),
    district: DISTRICT.required(),
    stateCode: fields.stateCode.required(),
    pinCode: fields.pinCode.required(),
    temperatureClasses: fields.temperatureClasses.required(),
  }),
};

export const updateWarehouseSchema = {
  ...idParams,
  body: Joi.object({
    ...fields,
    district: DISTRICT,
    expectedVersion: VERSION.required(),
    confirm: Joi.array()
      .items(Joi.string().valid(...REVIEWABLE_FIELDS))
      .unique()
      .description('Imported values confirmed as correct (removed from reviewFields)'),
    reason: REASON,
  })
    .or(...Object.keys(fields), 'district', 'confirm')
    .messages({ 'object.missing': 'change or confirm at least one field' }),
};

export const statusSchema = {
  ...idParams,
  body: Joi.object({ expectedVersion: VERSION.required(), reason: REASON }),
};

export const discardSchema = {
  ...idParams,
  querystring: Joi.object({ expectedVersion: VERSION.required() }),
};
