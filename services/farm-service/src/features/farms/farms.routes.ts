import { internalAuth } from '@farmx/common/middleware';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, customer, rateLimit } from '../../middleware/guards.js';
import type { IdParams } from './farms.controller.js';
import { FARMS_DOCS, adminActionDocs } from './farms.docs.js';
import type {
  AdminAction,
  AdminFarmListQuery,
  AdminUpdateInput,
  DetailsInput,
  FarmCategory,
  FarmListQuery,
  LocationInput,
  OwnerPrefsInput,
  QuickSignupInput,
  UpdateActiveFarmInput,
} from './farms.types.js';
import {
  adminActionSchema,
  adminHistorySchema,
  adminListSchema,
  adminUpdateSchema,
  createDraftSchema,
  detailsSchema,
  idParams,
  internalBatchSchema,
  internalByCodeSchema,
  listFarmsSchema,
  locationSchema,
  ownerPrefsSchema,
  quickSignupSchema,
  submitSchema,
  updateActiveSchema,
  verifyPassSchema,
} from './farms.validation.js';

/** Mounted at `/farms` (gateway `/v1/farms`). Customers only; own farms only (404 otherwise). */
export const farmsRoutes: FastifyPluginAsync = async (app) => {
  const c = (request: FastifyRequest) => request.diScope.resolve('farmsController');

  app.get(
    '/categories',
    { schema: routeDocs(FARMS_DOCS.categories), preHandler: customer },
    (req, reply) => c(req).categories(req, reply),
  );
  app.get<{ Querystring: FarmListQuery }>(
    '/',
    { schema: { ...listFarmsSchema, ...routeDocs(FARMS_DOCS.list) }, preHandler: customer },
    (req) => c(req).list(req),
  );
  app.post<{ Body: { category: FarmCategory } }>(
    '/',
    {
      schema: { ...createDraftSchema, ...routeDocs(FARMS_DOCS.createDraft) },
      preHandler: [...customer, rateLimit('farm-create', 10, 86_400)],
    },
    (req, reply) => c(req).createDraft(req, reply),
  );
  app.post<{ Body: QuickSignupInput }>(
    '/quick',
    {
      schema: { ...quickSignupSchema, ...routeDocs(FARMS_DOCS.quick) },
      preHandler: [...customer, rateLimit('farm-quick', 5, 86_400)],
    },
    (req, reply) => c(req).quick(req, reply),
  );
  app.get<{ Params: { farmCode: string }; Querystring: { sig: string } }>(
    '/verify/:farmCode',
    {
      schema: { ...verifyPassSchema, ...routeDocs(FARMS_DOCS.verifyPass) },
      preHandler: [rateLimit('farm-verify', 30, 60)],
    },
    (req) => c(req).verifyPass(req),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...idParams, ...routeDocs(FARMS_DOCS.get) }, preHandler: customer },
    (req, reply) => c(req).get(req, reply),
  );
  app.patch<{ Params: IdParams; Body: UpdateActiveFarmInput }>(
    '/:id',
    {
      schema: { ...updateActiveSchema, ...routeDocs(FARMS_DOCS.updateActive) },
      preHandler: customer,
    },
    (req, reply) => c(req).updateActive(req, reply),
  );
  app.delete<{ Params: IdParams }>(
    '/:id',
    { schema: { ...idParams, ...routeDocs(FARMS_DOCS.discard) }, preHandler: customer },
    (req, reply) => c(req).discard(req, reply),
  );
  app.patch<{ Params: IdParams; Body: DetailsInput }>(
    '/:id/details',
    { schema: { ...detailsSchema, ...routeDocs(FARMS_DOCS.details) }, preHandler: customer },
    (req, reply) => c(req).details(req, reply),
  );
  app.put<{ Params: IdParams; Body: LocationInput }>(
    '/:id/location',
    { schema: { ...locationSchema, ...routeDocs(FARMS_DOCS.location) }, preHandler: customer },
    (req, reply) => c(req).location(req, reply),
  );
  app.patch<{ Params: IdParams; Body: OwnerPrefsInput }>(
    '/:id/owner',
    { schema: { ...ownerPrefsSchema, ...routeDocs(FARMS_DOCS.owner) }, preHandler: customer },
    (req, reply) => c(req).owner(req, reply),
  );
  app.post<{ Params: IdParams }>(
    '/:id/kyc/defer',
    { schema: { ...idParams, ...routeDocs(FARMS_DOCS.deferKyc) }, preHandler: customer },
    (req, reply) => c(req).deferKyc(req, reply),
  );
  app.post<{ Params: IdParams }>(
    '/:id/submit',
    {
      schema: { ...submitSchema, ...routeDocs(FARMS_DOCS.submit) },
      preHandler: [...customer, rateLimit('farm-submit', 10, 86_400)],
    },
    (req, reply) => c(req).submit(req, reply),
  );
  app.get<{ Params: IdParams }>(
    '/:id/pass',
    { schema: { ...idParams, ...routeDocs(FARMS_DOCS.pass) }, preHandler: customer },
    (req) => c(req).pass(req),
  );
};

const ACTION_PERMISSION: Readonly<Record<AdminAction, string>> = {
  suspend: 'customers.suspend',
  reactivate: 'customers.suspend',
  close: 'customers.suspend',
  reject: 'customers.verify',
  'request-changes': 'customers.verify',
};

/** Mounted at `/admin/farms` (gateway `/v1/admin/farms`). INTERNAL staff + permission keys. */
export const farmsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: AdminFarmListQuery }>(
    '/',
    {
      schema: { ...adminListSchema, ...routeDocs(FARMS_DOCS.adminList) },
      preHandler: admin('customers.view'),
    },
    (req) => req.diScope.resolve('farmsController').adminList(req),
  );
  app.get(
    '/stats',
    { schema: routeDocs(FARMS_DOCS.adminStats), preHandler: admin('customers.view') },
    (req) => req.diScope.resolve('farmsController').adminStats(),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    {
      schema: { ...idParams, ...routeDocs(FARMS_DOCS.adminGet) },
      preHandler: admin('customers.view'),
    },
    (req, reply) => req.diScope.resolve('farmsController').adminGet(req, reply),
  );
  app.get<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>(
    '/:id/history',
    {
      schema: { ...adminHistorySchema, ...routeDocs(FARMS_DOCS.adminHistory) },
      preHandler: admin('customers.view'),
    },
    (req) => req.diScope.resolve('farmsController').adminHistory(req),
  );
  app.patch<{ Params: IdParams; Body: AdminUpdateInput }>(
    '/:id',
    {
      schema: { ...adminUpdateSchema, ...routeDocs(FARMS_DOCS.adminUpdate) },
      preHandler: admin('customers.update'),
    },
    (req, reply) => req.diScope.resolve('farmsController').adminUpdate(req, reply),
  );
  for (const action of Object.keys(ACTION_PERMISSION) as AdminAction[]) {
    const permission = ACTION_PERMISSION[action];
    app.post<{
      Params: IdParams;
      Body: { reason: string; issues?: { docType: string; code: string; message: string }[] };
    }>(
      `/:id/${action}`,
      {
        schema: {
          params: idParams.params,
          body: adminActionSchema.body,
          ...routeDocs(adminActionDocs(action, permission)),
        },
        preHandler: admin(permission),
      },
      (req, reply) => req.diScope.resolve('farmsController').adminAction(action, req, reply),
    );
  }
};

/** Mounted at `/internal/farms`: service-to-service only, never routed by the gateway. */
export const farmsInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;
  const guard = [internalAuth(token)];
  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...idParams, hide: true }, preHandler: guard },
    (req) => req.diScope.resolve('farmsController').internalGet(req),
  );
  app.post<{ Body: { ids: string[] } }>(
    '/batch',
    { schema: { ...internalBatchSchema, hide: true }, preHandler: guard },
    (req) => req.diScope.resolve('farmsController').internalBatch(req),
  );
  app.get<{ Params: { farmCode: string } }>(
    '/by-code/:farmCode',
    { schema: { ...internalByCodeSchema, hide: true }, preHandler: guard },
    (req) => req.diScope.resolve('farmsController').internalByCode(req),
  );
};
