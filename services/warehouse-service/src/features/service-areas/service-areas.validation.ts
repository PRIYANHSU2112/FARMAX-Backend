import Joi from 'joi';

import { DISTRICT, ID, PIN_CODE, STATE_CODE, VERSION } from '../../middleware/http.js';
import { PIN_OR_RANGE } from './service-areas.pins.js';
import { AREA_PRIORITIES } from './service-areas.types.js';

const PIN_ENTRY = Joi.string()
  .trim()
  .pattern(PIN_OR_RANGE)
  .messages({ 'string.pattern.base': 'must be a 6-digit PIN or a range like 411001-411045' });
const PIN_LIST = Joi.array().items(PIN_ENTRY).max(1_000);
const PRIORITY = Joi.string().valid(...AREA_PRIORITIES);

const warehouseParams = { params: Joi.object({ id: ID.required() }) };
const areaParams = { params: Joi.object({ id: ID.required(), areaId: ID.required() }) };

export const listAreasSchema = warehouseParams;
export const getAreaSchema = areaParams;

export const createAreaSchema = {
  ...warehouseParams,
  body: Joi.object({
    expectedVersion: VERSION.required(),
    stateCode: STATE_CODE.required(),
    district: DISTRICT.required(),
    priority: PRIORITY.required(),
    pins: PIN_LIST.min(1).required(),
  }),
};

export const updateAreaSchema = {
  ...areaParams,
  body: Joi.object({
    expectedVersion: VERSION.required(),
    stateCode: STATE_CODE,
    district: DISTRICT,
    priority: PRIORITY,
    addPins: PIN_LIST,
    removePins: PIN_LIST,
  })
    .or('stateCode', 'district', 'priority', 'addPins', 'removePins')
    .messages({ 'object.missing': 'change at least one thing' }),
};

export const deleteAreaSchema = {
  ...areaParams,
  querystring: Joi.object({ expectedVersion: VERSION.required() }),
};

export const deleteAreasSchema = {
  ...warehouseParams,
  querystring: Joi.object({
    expectedVersion: VERSION.required(),
    ids: Joi.string()
      .pattern(/^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,49}$/i)
      .required()
      .description('Comma-separated area ids (≤ 50)'),
  }),
};

export const reassignSchema = {
  ...areaParams,
  body: Joi.object({
    expectedVersion: VERSION.required(),
    pins: PIN_LIST,
    all: Joi.boolean().valid(true),
    stateCode: STATE_CODE.required(),
    district: DISTRICT.required(),
    priority: PRIORITY.required(),
  })
    .xor('pins', 'all')
    .messages({ 'object.xor': 'send either pins or all: true' }),
};

export const coverageSchema = { params: Joi.object({ pinCode: PIN_CODE.required() }) };
export const districtsSchema = { querystring: Joi.object({ stateCode: STATE_CODE.required() }) };
