import { createHash } from 'node:crypto';

import { BadRequestError } from '@farmx/common/errors';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import type { FastifyRequest } from 'fastify';
import Joi from 'joi';

/** Joi primitives shared by every wallet-service feature. */
export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
export const PAGE = {
  cursor: ID,
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};
export const idParams = { params: Joi.object({ id: ID.required() }) };

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,64}$/;

/** Required `Idempotency-Key` header (8–64 chars) of a money-moving POST. */
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
