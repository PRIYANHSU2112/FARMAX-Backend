import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import type { NotificationApp, NotificationCategory } from '../../domain.js';
import { requireUser, userWrite } from '../../middleware/guards.js';
import { appOf, userOf } from '../../middleware/http.js';
import { INBOX_DOCS } from './notifications.docs.js';
import { openStream } from './notifications.stream.js';
import {
  appOnlySchema,
  inboxItemSchema,
  listInboxSchema,
  readAllSchema,
  streamSchema,
} from './notifications.validation.js';

interface AppQuery {
  app?: NotificationApp;
}
interface IdParams {
  id: string;
}

const inbox = (req: FastifyRequest) => req.diScope.resolve('inboxService');

/**
 * Mounted at `/notifications` (gateway: `/v1/notifications`). Every route reads the caller's own
 * inbox; the user id comes from the token and the app is checked against the token's user type.
 */
export const inboxRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Querystring: AppQuery & {
      unread?: boolean;
      category?: NotificationCategory;
      cursor?: string;
      limit: number;
    };
  }>(
    '/',
    { schema: { ...listInboxSchema, ...routeDocs(INBOX_DOCS.list) }, preHandler: requireUser },
    async (req) => {
      const { app: requested, limit, ...filters } = req.query;
      const page = await inbox(req).list(userOf(req).id, appOf(req, requested), {
        ...filters,
        limit,
      });
      return paginated({ ...page, limit });
    },
  );

  app.get<{ Querystring: AppQuery }>(
    '/unread-count',
    { schema: { ...appOnlySchema, ...routeDocs(INBOX_DOCS.unreadCount) }, preHandler: requireUser },
    async (req) =>
      ok({
        unreadCount: await inbox(req).unreadCount(userOf(req).id, appOf(req, req.query.app)),
      }),
  );

  app.get<{ Querystring: AppQuery }>(
    '/stream',
    { schema: { ...streamSchema, ...routeDocs(INBOX_DOCS.stream) }, preHandler: requireUser },
    async (req, reply) => {
      await openStream(req, reply, appOf(req, req.query.app));
    },
  );

  app.post<{ Body: AppQuery & { before?: Date } }>(
    '/read-all',
    {
      schema: { ...readAllSchema, ...routeDocs(INBOX_DOCS.readAll) },
      preHandler: userWrite('read-all', 30),
    },
    async (req) =>
      ok(await inbox(req).markAllRead(userOf(req).id, appOf(req, req.body.app), req.body.before)),
  );

  app.get<{ Params: IdParams; Querystring: AppQuery }>(
    '/:id',
    { schema: { ...inboxItemSchema, ...routeDocs(INBOX_DOCS.get) }, preHandler: requireUser },
    async (req) =>
      ok(await inbox(req).get(userOf(req).id, appOf(req, req.query.app), req.params.id)),
  );

  app.post<{ Params: IdParams; Querystring: AppQuery }>(
    '/:id/read',
    {
      schema: { ...inboxItemSchema, ...routeDocs(INBOX_DOCS.read) },
      preHandler: userWrite('read', 120),
    },
    async (req) =>
      ok(await inbox(req).markRead(userOf(req).id, appOf(req, req.query.app), req.params.id)),
  );
};
