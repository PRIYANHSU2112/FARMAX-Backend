import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

/** Joi schemas per route part; validated by @farmx/common's validator compiler (422 on error). */
export const listExamplesSchema = {
  querystring: Joi.object({
    cursor: Joi.string().guid(),
    limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
    q: Joi.string().trim().min(1).max(100),
  }),
};

export const getExampleSchema = {
  params: Joi.object({ id: Joi.string().guid().required() }),
};

export const createExampleSchema = {
  body: Joi.object({ name: Joi.string().trim().min(1).max(120).required() }),
};
