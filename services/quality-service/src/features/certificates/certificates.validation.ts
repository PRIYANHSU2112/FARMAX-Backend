import Joi from 'joi';

import { PAGE } from '../../middleware/http.js';

const CN = Joi.string()
  .trim()
  .pattern(/^CN-[A-Za-z0-9-]{2,24}$/);
const QR = Joi.string()
  .trim()
  .pattern(/^[A-Za-z0-9_.:-]{4,64}$/);

export const listSchema = {
  querystring: Joi.object({
    q: Joi.string().trim().max(40),
    ...PAGE,
    cursor: Joi.string().pattern(/^\d{1,6}$/),
  }),
};
export const unitSchema = { params: Joi.object({ qrCode: QR.required() }) };
export const consignmentSchema = { params: Joi.object({ cnNo: CN.required() }) };
export const watchSchema = {
  params: Joi.object({ cnNo: CN.required() }),
  body: Joi.object({ watch: Joi.boolean().required() }),
};
export const verifySchema = { params: Joi.object({ code: Joi.alternatives(CN, QR).required() }) };
