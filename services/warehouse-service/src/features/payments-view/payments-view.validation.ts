import Joi from 'joi';

import { ID } from '../../middleware/http.js';
import { PAGING } from '../../middleware/paging.js';

const MONTH = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/);
const LEDGER = {
  tab: Joi.string().valid('all', 'paid', 'pending', 'refunds', 'failed', 'held').default('all'),
  q: Joi.string().trim().min(1).max(60),
  warehouseId: ID,
  method: Joi.string().valid('upi', 'netbanking', 'card', 'wallet', 'emi'),
};

export const kpisQuery = { querystring: Joi.object({ warehouseId: ID, month: MONTH }) };
export const ordersQuery = {
  querystring: Joi.object({ ...LEDGER, ...PAGING }).oxor('cursor', 'page'),
};
export const csvQuery = { querystring: Joi.object(LEDGER) };
export const customerParams = { params: Joi.object({ userId: ID.required() }) };
export const slaQuery = { querystring: Joi.object({ month: MONTH }) };
