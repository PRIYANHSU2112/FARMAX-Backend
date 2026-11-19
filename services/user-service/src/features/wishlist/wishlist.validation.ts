import Joi from 'joi';

const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
const PAGE = {
  cursor: ID,
  limit: Joi.number().integer().min(1).max(50).default(20),
};

export const listSchema = { querystring: Joi.object(PAGE) };

export const addSchema = { body: Joi.object({ productId: ID.required() }) };

export const productParamsSchema = { params: Joi.object({ productId: ID.required() }) };

export const adminListSchema = {
  params: Joi.object({ userId: ID.required() }),
  querystring: Joi.object(PAGE),
};
