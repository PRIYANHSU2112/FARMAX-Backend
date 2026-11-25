import Joi from 'joi';

import { DATE, ID, NOTE, PAGE, RECEIPT, VERSION, idParams } from '../../middleware/http.js';

const cert = {
  certificateRef: Joi.string().trim().max(60),
  issuerName: Joi.string().trim().max(160),
  analystName: Joi.string().trim().max(120),
  signatoryName: Joi.string().trim().max(120),
  issuedAt: DATE,
  validUntil: DATE,
};
const result = Joi.object({
  paramCode: Joi.string().trim().uppercase().max(40).required(),
  valueNum: Joi.number().allow(null),
  valueText: Joi.string().trim().max(120).allow(null),
});
const results = Joi.array().items(result).max(60).required();

export const listSchema = {
  querystring: Joi.object({
    batchId: ID,
    status: Joi.string().valid(
      'UPLOADED',
      'LINKED',
      'RESULTS_ENTERED',
      'APPROVED',
      'REJECTED',
      'EXPIRED',
    ),
    source: Joi.string().valid('MANUFACTURER', 'INDEPENDENT'),
    expiringWithinDays: Joi.number().integer().min(0).max(365),
    q: Joi.string().trim().max(40),
    ...PAGE,
    cursor: ID,
  }),
};
export const getSchema = idParams;
export const uploadSchema = {
  body: Joi.object({
    receipt: RECEIPT.required(),
    batchNo: Joi.string().trim().max(40).required(),
    variantId: ID,
    cnNo: Joi.string().trim().max(20),
    ...cert,
  }),
};
export const confirmMappingSchema = {
  ...idParams,
  body: Joi.object({ batchId: ID, expectedVersion: VERSION.required() }),
};
export const resultsSchema = {
  ...idParams,
  body: Joi.object({ results, expectedVersion: VERSION.required(), ...cert }),
};
export const sampleResultsSchema = {
  ...idParams,
  body: Joi.object({ results, expectedVersion: VERSION.required(), receipt: RECEIPT, ...cert }),
};
export const reviewSchema = {
  ...idParams,
  body: Joi.object({
    decision: Joi.string().valid('APPROVE', 'REJECT').required(),
    note: NOTE.min(5).required(),
    expectedVersion: VERSION.required(),
  }),
};
