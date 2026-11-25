import Joi from 'joi';

import { ID, PAGE } from '../../middleware/http.js';

const DAY = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .messages({ 'string.pattern.base': 'must be a date YYYY-MM-DD (IST)' });

const DOC_TYPE = Joi.string().valid('TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE');
const DOC_STATUS = Joi.string().valid('ISSUED', 'PARTIALLY_CREDITED', 'CREDITED');
const PDF_STATUS = Joi.string().valid('PENDING', 'RENDERING', 'READY', 'FAILED');

export const orderParams = { params: Joi.object({ id: ID.required() }) };
export const orderDocParams = { params: Joi.object({ id: ID.required(), docId: ID.required() }) };
export const docParams = { params: Joi.object({ id: ID.required() }) };

export const searchSchema = {
  querystring: Joi.object({
    q: Joi.string().trim().min(3).max(20).description('Exact document no. or order no.'),
    orderId: ID,
    userId: ID,
    farmId: ID,
    docType: DOC_TYPE,
    status: DOC_STATUS,
    pdfStatus: PDF_STATUS,
    b2b: Joi.boolean().description('true: buyer has a GSTIN · false: unregistered'),
    from: DAY,
    to: DAY,
    ...PAGE,
  }),
};

export const retrySchema = {
  ...docParams,
  body: Joi.object({ reason: Joi.string().trim().min(5).max(300).required() }),
};

export const exportSchema = {
  querystring: Joi.object({ from: DAY.required(), to: DAY.required() }),
};
