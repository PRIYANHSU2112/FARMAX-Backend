import { createHash } from 'node:crypto';

import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Joi from 'joi';

/** Joi primitives shared by every product-service feature. */
export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
export const SLUG = Joi.string()
  .lowercase()
  .max(180)
  .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .messages({ 'string.pattern.base': 'must be lower-case letters, digits and single hyphens' });
export const REASON = Joi.string().trim().min(10).max(500).required();
export const PAGE = {
  cursor: ID,
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};
export const idParams = { params: Joi.object({ id: ID.required() }) };
export const reasonQuery = { querystring: Joi.object({ reason: REASON }) };

export const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

/** `If-Match: 3`, `"3"` or `W/"3"` → 3. Anything else is ignored (no check). */
export const parseIfMatch = (header: string | string[] | undefined): number | undefined => {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^W\//, '').replaceAll('"', ''));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

export const ifMatch = (request: FastifyRequest) => parseIfMatch(request.headers['if-match']);

/** Weak ETag of any JSON-serialisable body. */
export const etagOf = (body: unknown): string =>
  `W/"${createHash('sha1').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;

/** Public GET: ETag + cache headers; 304 with no body when the client copy is current. */
export const sendConditional = (request: FastifyRequest, reply: FastifyReply, body: unknown) => {
  const etag = etagOf(body);
  void reply.header('etag', etag).header('cache-control', PUBLIC_CACHE);
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.send(body);
};

/** Admin read/write of a versioned resource: `ETag: "<version>"`. */
export const withVersion = <T extends { version: number }>(reply: FastifyReply, view: T) => {
  void reply.header('etag', `"${String(view.version)}"`);
  return view;
};
