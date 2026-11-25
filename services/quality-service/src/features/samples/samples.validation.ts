import Joi from 'joi';

import { ID, NOTE, PAGE, VERSION, idParams } from '../../middleware/http.js';
import type { SampleAction } from './samples.rules.js';

const STATUSES = [
  'PENDING',
  'COLLECTED',
  'SENT',
  'ACKNOWLEDGED',
  'TESTING',
  'RESULTS_RECEIVED',
  'PASSED',
  'FAILED',
  'CANCELLED',
];

export const summarySchema = { querystring: Joi.object({ warehouseId: ID }) };

export const listSchema = {
  querystring: Joi.object({
    warehouseId: ID,
    bucket: Joi.string().valid('pending', 'testing', 'passed', 'failed', 'cancelled'),
    status: Joi.string().valid(...STATUSES),
    labId: ID,
    batchId: ID,
    q: Joi.string().trim().max(40),
    ...PAGE,
    cursor: ID,
  }),
};

export const createSchema = {
  body: Joi.object({
    batchId: ID.required(),
    warehouseId: ID.required(),
    cnNo: Joi.string().trim().max(20),
    qty: Joi.number().integer().min(1).max(10_000).required(),
    qtyUnit: Joi.string().trim().max(20),
    labId: ID,
  }),
};

export const getSchema = idParams;

const at = Joi.date().iso();
export const actionSchemas: Record<
  SampleAction,
  { params: Joi.ObjectSchema; body: Joi.ObjectSchema }
> = {
  collect: {
    ...idParams,
    body: Joi.object({ expectedVersion: VERSION.required(), at, note: NOTE }),
  },
  send: {
    ...idParams,
    body: Joi.object({
      expectedVersion: VERSION.required(),
      at,
      labRef: Joi.string().trim().max(40),
      note: NOTE,
    }),
  },
  'lab-status': {
    ...idParams,
    body: Joi.object({
      expectedVersion: VERSION.required(),
      status: Joi.string().valid('ACKNOWLEDGED', 'TESTING', 'RESULTS_RECEIVED').required(),
      labRef: Joi.string().trim().max(40),
      at,
      note: NOTE,
    }),
  },
  flag: {
    ...idParams,
    body: Joi.object({ expectedVersion: VERSION.required(), note: NOTE.min(5).required() }),
  },
  cancel: {
    ...idParams,
    body: Joi.object({ expectedVersion: VERSION.required(), note: NOTE.min(5).required() }),
  },
};
