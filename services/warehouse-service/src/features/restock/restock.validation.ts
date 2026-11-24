import Joi from 'joi';
import { ID, REASON, VERSION } from '../../middleware/http.js';
import { PAGING } from '../../middleware/paging.js';

const DATE = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .messages({ 'string.pattern.base': 'must be a date YYYY-MM-DD' });
const MONTH = Joi.string()
  .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
  .messages({ 'string.pattern.base': 'must be a month YYYY-MM' });
const QTY = Joi.number().integer().min(1).max(1_000_000);
const NOTE = Joi.string().trim().max(500).allow(null, '');
const LINES = Joi.array()
  .items(Joi.object({ variantId: ID.required(), requestedQty: QTY.required() }))
  .min(1)
  .max(200);
const TYPE = Joi.string().valid('PROCUREMENT', 'TRANSFER');
export const REQUEST_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'IN_TRANSIT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
] as const;

export const idParam = { params: Joi.object({ id: ID.required() }) };

export const prefillQuery = {
  querystring: Joi.object({
    warehouseId: ID.required(),
    variantIds: Joi.string()
      .pattern(/^[0-9a-fA-F-]{36}(,[0-9a-fA-F-]{36}){0,99}$/)
      .required()
      .messages({ 'string.pattern.base': 'comma-separated SKU ids (max 100)' }),
  }),
};

export const createSchema = {
  body: Joi.object({
    type: TYPE.required(),
    destWarehouseId: ID.required(),
    sourceWarehouseId: ID.allow(null).when('type', {
      is: 'TRANSFER',
      then: Joi.required(),
      otherwise: Joi.forbidden(),
    }),
    vendorId: ID.allow(null).when('type', {
      is: 'PROCUREMENT',
      then: Joi.required(),
      otherwise: Joi.forbidden(),
    }),
    requiredBy: DATE.required(),
    periodMonth: MONTH,
    notes: NOTE,
    lines: LINES.required(),
  }),
};

export const updateSchema = {
  ...idParam,
  body: Joi.object({
    type: TYPE,
    sourceWarehouseId: ID.allow(null),
    vendorId: ID.allow(null),
    requiredBy: DATE,
    notes: NOTE,
    lines: LINES,
    expectedVersion: VERSION.required(),
  }).min(2),
};

export const listQuery = {
  querystring: Joi.object({
    month: MONTH,
    status: Joi.string().valid(...REQUEST_STATUSES),
    type: TYPE,
    warehouseId: ID,
    ...PAGING,
  }),
};

export const noteSchema = { ...idParam, body: Joi.object({ note: NOTE }).empty(null).default({}) };

export const approveSchema = {
  ...idParam,
  body: Joi.object({
    note: NOTE,
    lines: Joi.array()
      .items(
        Joi.object({
          variantId: ID.required(),
          approvedQty: Joi.number().integer().min(0).max(1_000_000).required(),
        }),
      )
      .max(200),
  })
    .empty(null)
    .default({}),
};

export const rejectSchema = { ...idParam, body: Joi.object({ note: REASON.required() }) };

export const dispatchSchema = {
  ...idParam,
  body: Joi.object({
    etaAt: Joi.date().iso(),
    lines: Joi.array()
      .items(
        Joi.object({
          variantId: ID.required(),
          qty: Joi.number().integer().min(0).max(1_000_000).required(),
        }),
      )
      .max(200),
  })
    .empty(null)
    .default({}),
};

export const transfersQuery = {
  querystring: Joi.object({
    status: Joi.string().valid('IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'),
    warehouseId: ID,
    direction: Joi.string().valid('in', 'out'),
    cursor: Joi.string().max(400),
    limit: PAGING.limit,
  }),
};

export const receiveSchema = {
  ...idParam,
  body: Joi.object({
    lines: Joi.array()
      .items(
        Joi.object({
          lineNo: Joi.number().integer().min(1).required(),
          receivedQty: Joi.number().integer().min(0).max(1_000_000).required(),
          binId: ID.allow(null),
        }),
      )
      .max(200)
      .default([]),
    notes: NOTE,
    close: Joi.boolean().default(false),
  }),
};
