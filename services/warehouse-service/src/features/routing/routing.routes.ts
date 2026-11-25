import { Readable } from 'node:stream';

import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { type Audience, audRead, audWrite, callerOf, rateLimit } from '../../middleware/guards.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import { routingDocs } from './routing.docs.js';
import type { RuleStatus } from './routing.service.js';
import * as V from './routing.validation.js';

type Q = Record<string, string | number | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const p = (req: FastifyRequest) => req.params as Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of the validated body
const b = <T>(req: FastifyRequest) => req.body as T;
const svc = (req: FastifyRequest) => req.diScope.resolve('routingService');
const id = (req: FastifyRequest) => p(req).id ?? '';
const paging = (req: FastifyRequest): Paging => ({
  limit: Number(q(req).limit ?? 20),
  ...(q(req).cursor === undefined ? {} : { cursor: String(q(req).cursor) }),
});
const date = (v: string | number | undefined) => (v === undefined ? undefined : new Date(v));

/**
 * D-57b W3.12 routing rules engine. Reads on both panels (`fulfilment.view`); simulation needs
 * `routing.manage`; every write is admin-panel only (GLOBAL `routing.manage`).
 */
export const routingRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = routingDocs(aud);
    type Docs = Parameters<typeof routeDocs>[0];
    const get = (
      path: string,
      schema: object,
      docs: Docs,
      h: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    ) =>
      app.get(
        path,
        { schema: { ...schema, ...routeDocs(docs) }, preHandler: audRead(aud, 'fulfilment.view') },
        h,
      );
    const write = (
      method: 'post' | 'put' | 'patch' | 'delete',
      path: string,
      schema: object,
      docs: Docs,
      h: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    ) =>
      app[method](
        path,
        { schema: { ...schema, ...routeDocs(docs) }, preHandler: audWrite(aud, 'routing.manage') },
        h,
      );

    get('/routing/summary', V.summaryQuery, D.summary, async (req) =>
      ok(
        await svc(req).summary({
          ...(q(req).from === undefined ? {} : { from: date(q(req).from) }),
          ...(q(req).to === undefined ? {} : { to: date(q(req).to) }),
        }),
      ),
    );
    get('/routing/rules', V.rulesQuery, D.rules, async (req) => {
      const f = q(req);
      return ok(
        await svc(req).rules({
          ...(f.q === undefined ? {} : { q: String(f.q) }),
          ...(f.status === undefined ? {} : { status: f.status as RuleStatus }),
          ...(f.tag === undefined ? {} : { tag: String(f.tag) }),
          ...(f.priorityFrom === undefined ? {} : { priorityFrom: Number(f.priorityFrom) }),
          ...(f.priorityTo === undefined ? {} : { priorityTo: Number(f.priorityTo) }),
        }),
      );
    });
    app.get(
      '/routing/rules/export.csv',
      {
        schema: routeDocs(D.csv),
        preHandler: [...audRead(aud, 'fulfilment.view'), rateLimit('export', 5, 60)],
      },
      async (req, reply) =>
        reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="routing-rules-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          .send(Readable.from(svc(req).exportCsv())),
    );
    get('/routing/rules/:id', V.ruleParams, D.rule, async (req) =>
      ok(await svc(req).rule(id(req))),
    );
    get('/routing/rules/:id/history', V.ruleHistoryQuery, D.ruleHistory, async (req) =>
      pageBody(await svc(req).history(id(req), paging(req))),
    );
    get('/routing/history', V.historyQuery, D.history, async (req) =>
      pageBody(await svc(req).history(undefined, paging(req))),
    );
    get('/routing/audit', V.historyQuery, D.audit, async (req) =>
      pageBody(await svc(req).audit(paging(req))),
    );
    get('/routing/condition-catalog', {}, D.catalog, async (req) => ok(await svc(req).catalog()));
    get('/routing/fallback', {}, D.fallback, async (req) => ok(await svc(req).fallback()));
    get('/routing/node-load', {}, D.nodeLoad, async (req) => ok(await svc(req).nodeLoad()));

    // Simulation: both panels, `routing.manage` (POST: it reads only).
    app.post(
      '/routing/simulate',
      {
        schema: { ...V.simulateSchema, ...routeDocs(D.simulate) },
        preHandler: [...audRead(aud, 'routing.manage'), rateLimit('routing-sim', 60, 60)],
      },
      async (req) => ok(await svc(req).simulate(callerOf(req), b(req))),
    );
    app.post(
      '/routing/simulate-matrix',
      {
        schema: { ...V.matrixSchema, ...routeDocs(D.matrix) },
        preHandler: [...audRead(aud, 'routing.manage'), rateLimit('routing-sim', 60, 60)],
      },
      async (req) => ok(await svc(req).simulateMatrix(callerOf(req), b(req))),
    );

    if (aud !== 'admin') return;

    write('post', '/routing/rules', V.createSchema, D.create, async (req, reply) =>
      reply.code(201).send(ok(await svc(req).create(callerOf(req), b(req)))),
    );
    write('patch', '/routing/rules/:id', V.patchSchema, D.patch, async (req) =>
      ok(await svc(req).patch(callerOf(req), id(req), b(req))),
    );
    write('delete', '/routing/rules/:id', V.deleteSchema, D.remove, async (req) => {
      await svc(req).remove(callerOf(req), id(req), b(req));
      return ok({ deleted: true });
    });
    write('post', '/routing/rules/:id/enable', V.versionSchema, D.enable, async (req) =>
      ok(await svc(req).setEnabled(callerOf(req), id(req), true, b(req))),
    );
    write('post', '/routing/rules/:id/disable', V.versionSchema, D.disable, async (req) =>
      ok(await svc(req).setEnabled(callerOf(req), id(req), false, b(req))),
    );
    write('put', '/routing/rules/order', V.orderSchema, D.order, async (req) =>
      ok(await svc(req).reorder(callerOf(req), b(req))),
    );
    write(
      'post',
      '/routing/rules/:id/duplicate',
      V.duplicateSchema,
      D.duplicate,
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).duplicate(callerOf(req), id(req), b(req)))),
    );
    write('put', '/routing/fallback', V.fallbackSchema, D.fallbackSave, async (req) =>
      ok(await svc(req).putFallback(callerOf(req), b(req))),
    );
    write('put', '/routing/throttles/:warehouseId', V.throttleSchema, D.throttle, async (req) =>
      ok(await svc(req).putThrottle(callerOf(req), p(req).warehouseId ?? '', b(req))),
    );
    write('post', '/routing/republish', {}, D.republish, async (req) =>
      ok(await svc(req).republish(callerOf(req))),
    );
  };
