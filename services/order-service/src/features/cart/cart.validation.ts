import Joi from 'joi';

import { ID } from '../../middleware/http.js';
import { HARD_MAX_QTY } from './cart.views.js';

const QTY = Joi.number().integer().max(HARD_MAX_QTY);
const VERSION = Joi.number().integer().min(0);
const variantParams = Joi.object({ variantId: ID.required() });

export const getCartSchema = { querystring: Joi.object({ farmId: ID }) };
export const addItemSchema = {
  body: Joi.object({ variantId: ID.required(), qty: QTY.min(1).required() }),
};
export const setItemSchema = {
  params: variantParams,
  body: Joi.object({ qty: QTY.min(0).required(), expectedVersion: VERSION }),
};
export const removeItemSchema = {
  params: variantParams,
  querystring: Joi.object({ expectedVersion: VERSION }),
};
export const couponSchema = {
  body: Joi.object({ code: Joi.string().trim().min(1).max(40).required() }),
};
