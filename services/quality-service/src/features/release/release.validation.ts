import Joi from 'joi';

import { ID, RECEIPT, REASON, VERSION, idParams } from '../../middleware/http.js';

const batchParams = { params: Joi.object({ batchId: ID.required() }) };

export const releaseCheckSchema = batchParams;
export const decisionsListSchema = batchParams;
export const decideSchema = {
  ...batchParams,
  body: Joi.object({
    kind: Joi.string().valid('RELEASE', 'QUARANTINE', 'RECALL').required(),
    remarks: REASON.required(),
    evidence: Joi.array().items(RECEIPT).max(10),
    expectedVersion: VERSION.required(),
  }),
};
export const decisionSchema = idParams;
