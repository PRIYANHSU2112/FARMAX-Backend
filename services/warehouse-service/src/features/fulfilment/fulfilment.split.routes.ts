import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { type Audience, audRead, audWrite, callerOf } from '../../middleware/guards.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import type { BackorderStatus } from './fulfilment.backorders.repository.js';
import { amendDocs, splitDocs } from './fulfilment.split.docs.js';
import type { SplitStrategy } from './fulfilment.split.js';
import * as V from './fulfilment.split.validation.js';

type Q = Record<string, string | number | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const p = (req: FastifyRequest) => req.params as Record<string, string>;
const svc = (req: FastifyRequest) => req.diScope.resolve('fulfilmentSplit');
const oid = (req: FastifyRequest) => p(req).orderId ?? '';
const body = (req: FastifyRequest) => req.body as never;
const paging = (req: FastifyRequest): Paging => ({
  limit: Number(q(req).limit ?? 20),
  ...(q(req).cursor === undefined ? {} : { cursor: String(q(req).cursor) }),
  ...(q(req).page === undefined ? {} : { page: Number(q(req).page) }),
});

/** D-57b W3.14 split, partial & backorder (both audiences). Mounted inside fulfilmentRoutes. */
export const splitRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = splitDocs(aud);
    const R = audRead(aud, 'fulfilment.view');
    const W = (k: string) => audWrite(aud, k);
    const base = '/fulfilment/orders/:orderId';

    app.get(
      `${base}/split-context`,
      { schema: { ...V.orderParams, ...routeDocs(D.context) }, preHandler: R },
      async (req) => ok(await svc(req).context(callerOf(req), oid(req))),
    );
    app.get(
      `${base}/split-proposal`,
      { schema: { ...V.proposalQuery, ...routeDocs(D.proposal) }, preHandler: R },
      async (req) =>
        ok(
          await svc(req).proposal(
            callerOf(req),
            oid(req),
            (q(req).strategy ?? 'NEAREST') as SplitStrategy,
          ),
        ),
    );
    app.get(
      `${base}/split-map`,
      { schema: { ...V.orderParams, ...routeDocs(D.map) }, preHandler: R },
      async (req) => ok(await svc(req).splitMap(callerOf(req), oid(req))),
    );
    app.post(
      `${base}/split-preview`,
      { schema: { ...V.previewSchema, ...routeDocs(D.preview) }, preHandler: R },
      async (req) => ok(await svc(req).preview(callerOf(req), oid(req), body(req))),
    );
    app.post(
      `${base}/split`,
      {
        schema: { ...V.splitSchema, ...routeDocs(D.split) },
        preHandler: W('fulfilment.reallocate'),
      },
      async (req) => ok(await svc(req).execute(callerOf(req), oid(req), body(req))),
    );
    app.post(
      `${base}/reroute`,
      {
        schema: { ...V.rerouteSchema, ...routeDocs(D.reroute) },
        preHandler: W('fulfilment.reallocate'),
      },
      async (req) => ok(await svc(req).reroute(callerOf(req), oid(req), body(req))),
    );
    app.post(
      `${base}/partial`,
      {
        schema: { ...V.partialSchema, ...routeDocs(D.partial) },
        preHandler: W('fulfilment.manage'),
      },
      async (req) => ok(await svc(req).partial(callerOf(req), oid(req), body(req))),
    );

    app.get(
      '/fulfilment/backorders',
      { schema: { ...V.backordersQuery, ...routeDocs(D.backorders) }, preHandler: R },
      async (req) => {
        const f = q(req);
        const page = await svc(req).backorders(
          callerOf(req),
          {
            ...(f.status === undefined ? {} : { status: f.status as BackorderStatus }),
            ...(f.warehouseId === undefined ? {} : { warehouseId: String(f.warehouseId) }),
            ...(f.orderId === undefined ? {} : { orderId: String(f.orderId) }),
            ...(f.variantId === undefined ? {} : { variantId: String(f.variantId) }),
          },
          paging(req),
        );
        return { ...pageBody(page), counts: page.counts };
      },
    );
    app.patch(
      '/fulfilment/backorders/:id',
      {
        schema: { ...V.backorderPatchSchema, ...routeDocs(D.backorderPatch) },
        preHandler: W('fulfilment.manage'),
      },
      async (req) => ok(await svc(req).patchBackorder(callerOf(req), p(req).id ?? '', body(req))),
    );
    app.post(
      '/fulfilment/backorders/:id/cancel',
      {
        schema: { ...V.backorderCancelSchema, ...routeDocs(D.backorderCancel) },
        preHandler: W('fulfilment.manage'),
      },
      async (req) => ok(await svc(req).cancelBackorder(callerOf(req), p(req).id ?? '', body(req))),
    );
    app.get(
      '/fulfilment/dispatch-slots',
      { schema: { ...V.slotsQuery, ...routeDocs(D.slots) }, preHandler: R },
      async (req) => {
        const c = callerOf(req);
        const wid = String(q(req).warehouseId);
        c.access.require('fulfilment.view', wid);
        return ok(await svc(req).slots(c, wid, Number(q(req).days ?? 3)));
      },
    );

    // ── W3.15 amendments + manifest ──
    const A = amendDocs(aud);
    const amend = (req: FastifyRequest) => req.diScope.resolve('fulfilmentAmendments');
    app.post(
      `${base}/amendments/quote`,
      { schema: { ...V.quoteSchema, ...routeDocs(A.quote) }, preHandler: R },
      async (req) => ok(await amend(req).quote(callerOf(req), oid(req), body(req))),
    );
    app.post(
      `${base}/amendments`,
      { schema: { ...V.amendSchema, ...routeDocs(A.amend) }, preHandler: W('fulfilment.manage') },
      async (req) => ok(await amend(req).amend(callerOf(req), oid(req), body(req))),
    );
    app.get(
      '/fulfilment/shipments/:id/manifest',
      { schema: { ...V.shipmentParams, ...routeDocs(A.manifest) }, preHandler: R },
      async (req) => ok(await amend(req).manifest(callerOf(req), p(req).id ?? '')),
    );
  };
