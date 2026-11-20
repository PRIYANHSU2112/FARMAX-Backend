import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import type { DeliveryChannel } from '../../adapters/queues.js';
import { admin, adminWrite } from '../../middleware/guards.js';
import { idempotencyKeyOf } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { ADMIN_DOCS } from './notifications.admin.docs.js';
import type { AdminListQuery, DeliveryListQuery, SendInput } from './notifications.admin.types.js';
import {
  analyticsSchema,
  cancelSchema,
  deliveriesSchema,
  getSchema,
  listSchema,
  retryFailedSchema,
  retryOneSchema,
  sendSchema,
} from './notifications.admin.validation.js';

interface IdParams {
  id: string;
}
interface Reason {
  reason: string;
}
const svc = (req: FastifyRequest) => req.diScope.resolve('notificationsAdminService');

/** Mounted at `/admin/notifications` (gateway: `/v1/admin/notifications`). Staff only. */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: SendInput }>(
    '/',
    {
      schema: { ...sendSchema, ...routeDocs(ADMIN_DOCS.send) },
      preHandler: adminWrite('notifications.manage'),
    },
    async (req, reply) => {
      const { notification, replayed } = await svc(req).send(
        actorOf(req),
        idempotencyKeyOf(req),
        req.body,
      );
      if (replayed) void reply.header('idempotent-replay', 'true');
      return reply.code(replayed ? 200 : 201).send(ok(notification));
    },
  );

  app.get<{ Querystring: AdminListQuery }>(
    '/',
    {
      schema: { ...listSchema, ...routeDocs(ADMIN_DOCS.list) },
      preHandler: admin('notifications.view'),
    },
    async (req) => paginated({ ...(await svc(req).list(req.query)), limit: req.query.limit }),
  );

  app.get<{ Querystring: { from?: Date; to?: Date } }>(
    '/analytics',
    {
      schema: { ...analyticsSchema, ...routeDocs(ADMIN_DOCS.analytics) },
      preHandler: admin('notifications.view'),
    },
    async (req) => ok(await svc(req).analytics(req.query.from, req.query.to)),
  );

  app.get<{ Querystring: DeliveryListQuery }>(
    '/deliveries',
    {
      schema: { ...deliveriesSchema, ...routeDocs(ADMIN_DOCS.deliveries) },
      preHandler: admin('notifications.view'),
    },
    async (req) =>
      paginated({ ...(await svc(req).listDeliveries(req.query)), limit: req.query.limit }),
  );

  app.post<{ Body: Reason & { notificationId?: string; channel?: DeliveryChannel } }>(
    '/deliveries/retry-failed',
    {
      schema: { ...retryFailedSchema, ...routeDocs(ADMIN_DOCS.retryFailed) },
      preHandler: adminWrite('notifications.manage'),
    },
    async (req) => {
      const { reason, ...filter } = req.body;
      return ok(await svc(req).retryFailed(actorOf(req), filter, reason));
    },
  );

  app.post<{ Params: IdParams; Body: Reason }>(
    '/deliveries/:id/retry',
    {
      schema: { ...retryOneSchema, ...routeDocs(ADMIN_DOCS.retryOne) },
      preHandler: adminWrite('notifications.manage'),
    },
    async (req) => ok(await svc(req).retryDelivery(actorOf(req), req.params.id, req.body.reason)),
  );

  app.get<{ Params: IdParams }>(
    '/:id',
    {
      schema: { ...getSchema, ...routeDocs(ADMIN_DOCS.get) },
      preHandler: admin('notifications.view'),
    },
    async (req) => ok(await svc(req).get(req.params.id)),
  );

  app.post<{ Params: IdParams; Body: Reason }>(
    '/:id/cancel',
    {
      schema: { ...cancelSchema, ...routeDocs(ADMIN_DOCS.cancel) },
      preHandler: adminWrite('notifications.manage'),
    },
    async (req) => ok(await svc(req).cancel(actorOf(req), req.params.id, req.body.reason)),
  );
};
