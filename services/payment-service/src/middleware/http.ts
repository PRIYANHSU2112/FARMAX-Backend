import { createHash } from 'node:crypto';

import { BadRequestError } from '@farmx/common/errors';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import type { FastifyRequest } from 'fastify';
import Joi from 'joi';

/** Joi primitives shared by every inventory-service feature. */
export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
export const REASON = Joi.string().trim().min(10).max(500);
export const PAGE = {
  cursor: ID,
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};
export const idParams = { params: Joi.object({ id: ID.required() }) };
export const PIN_CODE = Joi.string().pattern(/^[1-9][0-9]{5}$/).messages({
  'string.pattern.base': 'must be a 6-digit Indian PIN code',
});
/** Whole units of one variant in one movement. */
export const QTY = Joi.number().integer().min(1).max(1_000_000);

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,64}$/;

/** Required `Idempotency-Key` header (8–64 chars) of a stock-changing POST. */
export const idempotencyKeyOf = (request: FastifyRequest): string => {
  const header = request.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || !IDEMPOTENCY_KEY.test(key))
    throw new BadRequestError('Idempotency-Key header is required (8–64 of A-Z a-z 0-9 . _ : -)');
  return key;
};

/** JSON with sorted object keys, so the same request always hashes the same. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/** SHA-256 of the canonical request: same Idempotency-Key + different body → 422. */
export const requestHash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

/** The single row an INSERT … RETURNING / a known-present read must produce. */
export const one = <T>(rows: readonly T[], what: string): T => {
  const [row] = rows;
  if (row === undefined) throw new Error(`expected one ${what}, got none`);
  return row;
};
