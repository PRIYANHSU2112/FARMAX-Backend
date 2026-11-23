import Joi from 'joi';

import { ID, RES_CODE, TIME, VERSION } from '../../middleware/http.js';
import { TEMP_CLASSES } from '../warehouses/index.js';

const STATUS = Joi.string().valid('ACTIVE', 'INACTIVE', 'MAINTENANCE');
const VEHICLE = Joi.string().valid('MINI_TRUCK', 'TRUCK', 'HEAVY_TRUCK', 'ANY');
const wh = { id: ID.required() };

const doorFields = {
  name: Joi.string().trim().min(1).max(80),
  type: Joi.string().valid('UNLOADING', 'LOADING', 'BOTH'),
  vehicleClass: VEHICLE,
  capacityPerDay: Joi.number().positive().max(100_000).precision(2),
  capacityUnit: Joi.string().valid('TONNES', 'PALLETS'),
  opensAt: TIME.allow(null),
  closesAt: TIME.allow(null),
  status: STATUS,
};

export const warehouseOnly = { params: Joi.object(wh) };

export const createDoorSchema = {
  params: Joi.object(wh),
  body: Joi.object({
    ...doorFields,
    code: RES_CODE.required(),
    name: doorFields.name.required(),
    type: doorFields.type.required(),
    vehicleClass: doorFields.vehicleClass.required(),
    capacityPerDay: doorFields.capacityPerDay.required(),
    capacityUnit: doorFields.capacityUnit.required(),
  }),
};

export const updateDoorSchema = {
  params: Joi.object({ ...wh, doorId: ID.required() }),
  body: Joi.object({ ...doorFields, expectedVersion: VERSION.required() }).or(
    ...Object.keys(doorFields),
  ),
};

export const doorParams = { params: Joi.object({ ...wh, doorId: ID.required() }) };

export const bookSchema = {
  params: Joi.object({ ...wh, doorId: ID.required() }),
  body: Joi.object({
    refNo: Joi.string().trim().min(2).max(40).required(),
    direction: Joi.string().valid('INBOUND', 'OUTBOUND').required(),
    loadQty: Joi.number().positive().max(100_000).precision(2).required(),
    plannedStart: Joi.date().iso().raw().required(),
    plannedEnd: Joi.date().iso().raw().required(),
  }),
};

export const bookingParams = { params: Joi.object({ ...wh, bookingId: ID.required() }) };

export const bookingsSchema = {
  params: Joi.object(wh),
  querystring: Joi.object({
    date: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .description('Local date YYYY-MM-DD (default today in the warehouse timezone)'),
  }),
};

const stagingFields = {
  name: Joi.string().trim().min(1).max(80),
  kind: Joi.string().valid('INBOUND', 'OUTBOUND', 'BOTH'),
  capacityPallets: Joi.number().integer().min(1).max(100_000),
  temperatureClass: Joi.string().valid(...TEMP_CLASSES),
  status: STATUS,
};

export const createStagingSchema = {
  params: Joi.object(wh),
  body: Joi.object({
    ...stagingFields,
    name: stagingFields.name.required(),
    kind: stagingFields.kind.required(),
    capacityPallets: stagingFields.capacityPallets.required(),
  }),
};

export const updateStagingSchema = {
  params: Joi.object({ ...wh, stagingId: ID.required() }),
  body: Joi.object(stagingFields).or(...Object.keys(stagingFields)),
};

export const stagingParams = { params: Joi.object({ ...wh, stagingId: ID.required() }) };

export const createSlotSchema = {
  params: Joi.object(wh),
  body: Joi.object({
    code: RES_CODE.required(),
    vehicleClass: VEHICLE,
    status: Joi.string().valid('AVAILABLE', 'BLOCKED'),
  }),
};

export const updateSlotSchema = {
  params: Joi.object({ ...wh, slotId: ID.required() }),
  body: Joi.object({
    vehicleClass: VEHICLE,
    status: Joi.string().valid('AVAILABLE', 'BLOCKED'),
  }).or('vehicleClass', 'status'),
};

export const slotParams = { params: Joi.object({ ...wh, slotId: ID.required() }) };

export const occupySchema = {
  params: Joi.object({ ...wh, slotId: ID.required() }),
  body: Joi.object({ vehicleNo: Joi.string().trim().uppercase().min(4).max(20).required() }),
};
