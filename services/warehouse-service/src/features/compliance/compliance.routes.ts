import { Readable } from 'node:stream';

import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { type Audience, audRead, audWrite, callerOf, rateLimit } from '../../middleware/guards.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import { complianceDocs } from './compliance.docs.js';
import * as V from './compliance.validation.js';

type Q = Record<string, string | number | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const p = (req: FastifyRequest) => req.params as Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of the validated body
const b = <T>(req: FastifyRequest) => req.body as T;
const svc = (req: FastifyRequest) => req.diScope.resolve('complianceService');
const id = (req: FastifyRequest) => p(req).id ?? '';
const paging = (req: FastifyRequest): Paging => ({
  limit: Number(q(req).limit ?? 20),
  ...(q(req).cursor === undefined ? {} : { cursor: String(q(req).cursor) }),
  ...(q(req).page === undefined ? {} : { page: Number(q(req).page) }),
});
const opt = (v: string | number | undefined) => (v === undefined ? {} : { v: String(v) });

/** D-57b W3.16 compliance gate. Both audiences; registry / inspector writes on the admin panel. */
export const complianceRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = complianceDocs(aud);
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
      method: 'post' | 'put',
      path: string,
      schema: object,
      docs: Docs,
      key: string,
      h: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    ) =>
      app[method](
        path,
        { schema: { ...schema, ...routeDocs(docs) }, preHandler: audWrite(aud, key) },
        h,
      );

    get('/compliance/kpis', V.whQuery, D.kpis, async (req) =>
      ok(await svc(req).kpis(callerOf(req), q(req).warehouseId as string | undefined)),
    );
    get('/compliance/cases', V.casesQuery, D.cases, async (req) => {
      const f = q(req);
      const page = await svc(req).cases(
        callerOf(req),
        {
          ...(f.status === undefined ? {} : { status: String(f.status) }),
          ...(f.q === undefined ? {} : { q: String(f.q) }),
          ...(f.warehouseId === undefined ? {} : { warehouseId: String(f.warehouseId) }),
        },
        paging(req),
      );
      return pageBody(page);
    });
    get('/compliance/cases/:id', V.caseParams, D.case, async (req) =>
      ok(await svc(req).case(callerOf(req), id(req))),
    );
    get('/compliance/cases/:id/restricted-ledger', V.caseParams, D.ledger, async (req) =>
      ok(await svc(req).restrictedLedger(callerOf(req), id(req))),
    );
    get('/compliance/cases/:id/evidence', V.caseParams, D.evidence, async (req) =>
      ok(await svc(req).evidence(callerOf(req), id(req))),
    );
    get('/compliance/registry', {}, D.registry, async (req) => ok(await svc(req).registry()));
    get('/compliance/inspectors', {}, D.inspectors, async (req) => ok(await svc(req).inspectors()));
    app.get(
      '/compliance/audit/export.csv',
      {
        schema: { ...V.auditQuery, ...routeDocs(D.auditCsv) },
        preHandler: [...audRead(aud, 'fulfilment.view'), rateLimit('export', 5, 60)],
      },
      async (req, reply) =>
        reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="compliance-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          .send(
            Readable.from(
              svc(req).auditCsv(callerOf(req), {
                ...(q(req).status === undefined ? {} : { status: String(q(req).status) }),
                ...(opt(q(req).warehouseId).v === undefined
                  ? {}
                  : { warehouseId: String(q(req).warehouseId) }),
              }),
            ),
          ),
    );

    write(
      'post',
      '/compliance/cases/:id/documents',
      V.documentSchema,
      D.document,
      'fulfilment.manage',
      async (req) => ok(await svc(req).addDocument(callerOf(req), id(req), b(req))),
    );
    write(
      'post',
      '/compliance/cases/:id/evidence',
      V.evidenceSchema,
      D.addEvidence,
      'fulfilment.manage',
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).addEvidence(callerOf(req), id(req), b(req)))),
    );
    write(
      'post',
      '/compliance/cases/:id/checks/:checkId/decision',
      V.checkDecisionSchema,
      D.checkDecision,
      'compliance.review',
      async (req) =>
        ok(await svc(req).decideCheck(callerOf(req), id(req), p(req).checkId ?? '', b(req))),
    );
    write(
      'post',
      '/compliance/cases/:id/checks/:checkId/request',
      V.requestSchema,
      D.request,
      'fulfilment.manage',
      async (req) =>
        ok(await svc(req).requestDocument(callerOf(req), id(req), p(req).checkId ?? '', b(req))),
    );
    write(
      'put',
      '/compliance/cases/:id/inspector',
      V.inspectorSchema,
      D.inspector,
      'fulfilment.manage',
      async (req) => ok(await svc(req).setInspector(callerOf(req), id(req), b(req))),
    );
    write(
      'post',
      '/compliance/cases/:id/notes',
      V.noteSchema,
      D.note,
      'fulfilment.view',
      async (req, reply) =>
        reply
          .code(201)
          .send(ok(await svc(req).addNote(callerOf(req), id(req), b<{ body: string }>(req).body))),
    );
    write(
      'post',
      '/compliance/cases/:id/decision',
      V.decisionSchema,
      D.decision,
      'compliance.review',
      async (req) => ok(await svc(req).decide(callerOf(req), id(req), b(req))),
    );
    write(
      'post',
      '/compliance/cases/:id/waiver',
      V.waiverSchema,
      D.waiver,
      'compliance.review',
      async (req) => ok(await svc(req).waiver(callerOf(req), id(req), b(req))),
    );

    if (aud === 'admin') {
      write(
        'put',
        '/compliance/registry/:key',
        V.ruleSchema,
        D.ruleSave,
        'compliance.review',
        async (req) => ok(await svc(req).putRule(callerOf(req), p(req).key ?? '', b(req))),
      );
      write(
        'put',
        '/compliance/inspectors/:userId',
        V.inspectorPutSchema,
        D.inspectorSave,
        'compliance.review',
        async (req) => ok(await svc(req).putInspector(callerOf(req), p(req).userId ?? '', b(req))),
      );
    }
  };
