import { BadRequestError, ForbiddenError, UnauthorizedError } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import type { FastifyRequest } from 'fastify';
import Joi from 'joi';

import { APPS, type NotificationApp } from '../domain.js';
import { appsOf } from '../features/audience/index.js';

/** Joi primitives shared by every notification-service feature. */
export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
export const PAGE = {
  cursor: ID.description('`nextCursor` of the previous page'),
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};
export const idParams = { params: Joi.object({ id: ID.required() }) };
export const APP = Joi.string()
  .valid(...APPS)
  .description(
    "Which app's inbox. Allowed per account type: CUSTOMER → CUSTOMER · INTERNAL → ADMIN (default) or WAREHOUSE · LOGISTICS_PARTNER → LOGISTICS · VENDOR → VENDOR. Default: the first allowed.",
  );

/** The signed-in user (route must run requireUser first). */
export const userOf = (request: FastifyRequest): AuthUser => {
  if (request.user === null) throw new UnauthorizedError();
  return request.user;
};

/**
 * The app whose inbox the caller reads. Decided by the TOKEN's user type, never trusted from the
 * client: asking for another app's inbox → 403.
 */
export const appOf = (request: FastifyRequest, requested: NotificationApp | undefined) => {
  const allowed = appsOf(userOf(request).userType);
  const app = requested ?? allowed[0];
  if (app === undefined || !allowed.includes(app))
    throw new ForbiddenError('This app is not available for your account');
  return app;
};

/** Why a staff member did something (audited). */
export const REASON = Joi.string().trim().min(10).max(500);

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,64}$/;

/** Required `Idempotency-Key` header (8–64 chars) of a POST that creates something. */
export const idempotencyKeyOf = (request: FastifyRequest): string => {
  const header = request.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || !IDEMPOTENCY_KEY.test(key))
    throw new BadRequestError('Idempotency-Key header is required (8–64 of A-Z a-z 0-9 . _ : -)');
  return key;
};
