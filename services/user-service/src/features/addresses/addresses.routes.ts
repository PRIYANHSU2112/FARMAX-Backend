import { internalAuth } from '@farmx/common/middleware';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, customer, rateLimit } from '../../middleware/guards.js';
import type { IdParams, PageQuery, UserAddressParams, UserParams } from './addresses.controller.js';
import { ADDRESS_DOCS } from './addresses.docs.js';
import type { CreateAddressInput, UpdateAddressInput } from './addresses.types.js';
import {
  adminHistorySchema,
  adminListSchema,
  createSchema,
  idParamsSchema,
  snapshotSchema,
  updateSchema,
} from './addresses.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('addressesController');

/** Mounted at `/me/addresses` (gateway `/v1/me/addresses`). The caller's own addresses. */
export const addressesRoutes: FastifyPluginAsync = async (app) => {
  const read = [...customer, rateLimit('address-read', 120, 60)];
  const write = [...customer, rateLimit('address-write', 30, 60)];
  const D = ADDRESS_DOCS;

  app.get('/', { schema: routeDocs(D.list), preHandler: read }, (req) => c(req).list(req));
  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...idParamsSchema, ...routeDocs(D.get) }, preHandler: read },
    (req, reply) => c(req).get(req, reply),
  );
  app.post<{ Body: CreateAddressInput }>(
    '/',
    { schema: { ...createSchema, ...routeDocs(D.create) }, preHandler: write },
    (req, reply) => c(req).create(req, reply),
  );
  app.patch<{ Params: IdParams; Body: UpdateAddressInput }>(
    '/:id',
    { schema: { ...updateSchema, ...routeDocs(D.update) }, preHandler: write },
    (req, reply) => c(req).update(req, reply),
  );
  app.post<{ Params: IdParams }>(
    '/:id/default',
    { schema: { ...idParamsSchema, ...routeDocs(D.setDefault) }, preHandler: write },
    (req, reply) => c(req).setDefault(req, reply),
  );
  app.delete<{ Params: IdParams }>(
    '/:id',
    { schema: { ...idParamsSchema, ...routeDocs(D.remove) }, preHandler: write },
    (req, reply) => c(req).remove(req, reply),
  );
};

/** Mounted at `/admin/customers` (gateway `/v1/admin/customers`). Support, read-only. */
export const addressesAdminRoutes: FastifyPluginAsync = async (app) => {
  const view = admin('customers.view');

  app.get<{ Params: UserParams; Querystring: { includeDeleted: boolean } }>(
    '/:userId/addresses',
    { schema: { ...adminListSchema, ...routeDocs(ADDRESS_DOCS.adminList) }, preHandler: view },
    (req) => c(req).adminList(req),
  );
  app.get<{ Params: UserAddressParams; Querystring: PageQuery }>(
    '/:userId/addresses/:id/history',
    {
      schema: { ...adminHistorySchema, ...routeDocs(ADDRESS_DOCS.adminHistory) },
      preHandler: view,
    },
    (req) => c(req).adminHistory(req),
  );
};

/**
 * Mounted at `/internal/users` (never routed by the gateway, D-27; not in Swagger). Order-service
 * copies this snapshot into the order at checkout. Disabled when INTERNAL_SERVICE_TOKEN is unset.
 */
export const addressesInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;

  app.get<{ Params: UserAddressParams }>(
    '/:userId/addresses/:id',
    { schema: { hide: true, ...snapshotSchema }, preHandler: [internalAuth(token)] },
    (req) => c(req).snapshot(req),
  );
};
