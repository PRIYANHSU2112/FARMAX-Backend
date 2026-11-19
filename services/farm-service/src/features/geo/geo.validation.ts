import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

export const PIN = Joi.string()
  .pattern(/^[1-9][0-9]{5}$/)
  .messages({ 'string.pattern.base': 'must be a 6-digit pin code' });
export const REASON = Joi.string().trim().min(10).max(500).required();
const TERRITORY_CODE = Joi.string()
  .uppercase()
  .pattern(/^[A-Z]{2,3}$/);
const NODE_ID = Joi.string().guid().allow(null);
const NAME = Joi.string().trim().min(2).max(80);

export const lookupPinSchema = { params: Joi.object({ pin: PIN.required() }) };

export const listPinsSchema = {
  querystring: Joi.object({
    territoryCode: TERRITORY_CODE,
    cursor: PIN,
    limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  }),
};

export const upsertPinSchema = {
  params: Joi.object({ pin: PIN.required() }),
  body: Joi.object({
    territoryCode: TERRITORY_CODE.required(),
    districtName: NAME.required(),
    mandalName: NAME.allow(null),
    villages: Joi.array().items(NAME).max(200).unique(),
    primaryNodeId: NODE_ID,
    primaryNodeName: NAME.allow(null),
    backupNodeId: NODE_ID,
    backupNodeName: NAME.allow(null),
    deliveryPromise: Joi.string().trim().max(40).allow(null),
    serviceable: Joi.boolean(),
    reason: REASON,
  }),
};

const territoryFields = {
  code: TERRITORY_CODE,
  name: NAME,
  districtName: NAME,
  stateCode: Joi.string().uppercase().length(2),
  isActive: Joi.boolean(),
};

export const createTerritorySchema = {
  body: Joi.object({
    ...territoryFields,
    code: territoryFields.code.required(),
    name: territoryFields.name.required(),
    districtName: territoryFields.districtName.required(),
    stateCode: territoryFields.stateCode.required(),
    reason: REASON,
  }),
};

export const updateTerritorySchema = {
  params: Joi.object({ id: Joi.string().guid().required() }),
  // `code` is part of issued Farm IDs and pin rows, so it can never change.
  body: Joi.object({
    name: territoryFields.name,
    districtName: territoryFields.districtName,
    stateCode: territoryFields.stateCode,
    isActive: territoryFields.isActive,
    reason: REASON,
  }).min(2),
};
