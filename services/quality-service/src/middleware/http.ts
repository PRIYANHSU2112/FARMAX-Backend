import { AppError, ConflictError, ErrorCode } from '@farmx/common/errors';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import type { FastifyRequest } from 'fastify';
import Joi from 'joi';

/** Joi primitives shared by every quality-service feature. */
export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
export const REASON = Joi.string().trim().min(5).max(500);
export const NOTE = Joi.string().trim().max(500);
export const VERSION = Joi.number().integer().min(0);
export const PAGE = {
  cursor: Joi.string().max(200),
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};
export const DATE = Joi.string()
  .pattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  .messages({ 'string.pattern.base': 'must be a date YYYY-MM-DD' });
/** A media-service upload receipt (`base64url.base64url`). */
export const RECEIPT = Joi.string()
  .max(2048)
  .pattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const idParams = { params: Joi.object({ id: ID.required() }) };

/** `Idempotency-Key` header (8–64 safe chars). Required where a replay must not act twice. */
export const idempotencyKeyOf = (request: FastifyRequest): string => {
  const raw = request.headers['idempotency-key'];
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_.:-]{8,64}$/.test(raw))
    throw new AppError(
      ErrorCode.BAD_REQUEST,
      'Idempotency-Key header is required (8–64 characters [A-Za-z0-9_.:-])',
      400,
    );
  return raw;
};

/** `YYYY-MM-DD` → Date at UTC midnight (Prisma @db.Date). */
export const toDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** Date (@db.Date) → `YYYY-MM-DD`, null-safe. */
export const ymd = (value: Date | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toISOString().slice(0, 10);

/** 409 with a machine-readable reason (clients branch on `details.reason`). */
export const conflict = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
  new ConflictError(message, { details: { reason, ...extra } });

/** Optimistic-lock failure: someone else changed the row first. */
export const versionConflict = (
  currentVersion: number | null,
  extra: Record<string, unknown> = {},
) =>
  conflict('VERSION_CONFLICT', 'This was changed by someone else; reload and try again', {
    currentVersion,
    ...extra,
  });
