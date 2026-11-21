import { AppError, ErrorCode } from '@farmx/common/errors';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import type { FastifyRequest } from 'fastify';
import Joi from 'joi';

/** Joi primitives shared by every call-service feature. */
export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
export const REASON = Joi.string().trim().min(10).max(500);
export const PAGE = {
  cursor: ID,
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};
export const idParams = { params: Joi.object({ id: ID.required() }) };

/** IST calendar date `YYYY-MM-DD`. */
export const DATE = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).messages({
  'string.pattern.base': 'must be a date YYYY-MM-DD',
});

/**
 * Optional `If-Match: "<version>"` (or a bare number). Returns undefined when absent; a stale value
 * is a 409 raised by the service.
 */
export const ifMatchOf = (request: FastifyRequest): number | undefined => {
  const raw = request.headers['if-match'];
  if (raw === undefined) return undefined;
  const value = Number(raw.replace(/^W\//, '').replaceAll('"', ''));
  if (!Number.isInteger(value) || value < 0)
    throw new AppError(ErrorCode.BAD_REQUEST, 'If-Match must be the resource version', 400);
  return value;
};
