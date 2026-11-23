import { AppError, ErrorCode } from '@farmx/common/errors';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import type { FastifyRequest } from 'fastify';
import Joi from 'joi';

/** Joi primitives shared by every support-service feature. */
export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
export const REASON = Joi.string().trim().min(5).max(500);
export const PAGE = {
  cursor: ID,
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};
export const idParams = { params: Joi.object({ id: ID.required() }) };
export const DATE = Joi.string()
  .pattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  .messages({
    'string.pattern.base': 'must be a date YYYY-MM-DD',
  });
export const APPS = ['CUSTOMER', 'VENDOR', 'LOGISTICS', 'WAREHOUSE'] as const;
export type App = (typeof APPS)[number];
export const PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const;
export const TEAMS = ['SUPPORT', 'VET', 'LOGISTICS', 'FINANCE', 'QUALITY', 'WAREHOUSE'] as const;

/** `If-Match: "<version>"` (or a bare number); undefined when absent. */
export const ifMatchOf = (request: FastifyRequest): number | undefined => {
  const raw = request.headers['if-match'];
  if (raw === undefined) return undefined;
  const value = Number(raw.replace(/^W\//, '').replaceAll('"', ''));
  if (!Number.isInteger(value) || value < 0)
    throw new AppError(ErrorCode.BAD_REQUEST, 'If-Match must be the resource version', 400);
  return value;
};

/** `Idempotency-Key` header (8–64 safe chars); undefined when absent. */
export const idempotencyKeyOf = (request: FastifyRequest): string | undefined => {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_.:-]{8,64}$/.test(raw))
    throw new AppError(
      ErrorCode.BAD_REQUEST,
      'Idempotency-Key must be 8–64 characters [A-Za-z0-9_.:-]',
      400,
    );
  return raw;
};

/** Copy of an object without the given keys (e.g. audit-only `reason`, immutable `code`). */
export const omit = <T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> =>
  Object.fromEntries(
    Object.entries(obj).filter(([key]) => !(keys as readonly PropertyKey[]).includes(key)),
  ) as Omit<T, K>;
