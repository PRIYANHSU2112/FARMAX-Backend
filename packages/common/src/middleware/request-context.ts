import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { UserId } from '../types/index.js';
import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Only accept safe, bounded incoming ids (prevents log injection). */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export interface RequestContext {
  requestId: string;
  userId?: UserId;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Fastify `genReqId`: reuse a valid incoming `x-request-id` (set by NGINX / the gateway),
 * otherwise generate a UUID.
 */
export const genRequestId = (req: IncomingMessage): string => {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value !== undefined && VALID_REQUEST_ID.test(value) ? value : randomUUID();
};

/** Context of the request currently being handled, from anywhere in the call stack. */
export const getRequestContext = (): RequestContext | undefined => storage.getStore();

/** Records the authenticated user on the current request context. */
export const setContextUser = (userId: UserId): void => {
  const store = storage.getStore();
  if (store) store.userId = userId;
};

/** Runs `fn` inside a context (for jobs and event consumers, which have no HTTP request). */
export const runWithContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

const plugin: FastifyPluginCallback = (app, _opts, done) => {
  app.addHook('onRequest', (request, reply, next) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    storage.run({ requestId: request.id }, next);
  });
  done();
};

/** Opens an AsyncLocalStorage context per request and echoes `x-request-id` back. */
export const requestContextPlugin = fp(plugin, { name: '@farmx/request-context' });
