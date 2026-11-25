import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { type Audience, audRead, audWrite, callerOf } from '../../middleware/guards.js';
import { sendIdempotent } from '../../middleware/idempotency.js';
import { type Paging, pageBody } from '../../middleware/paging.js';
import { gateDocs } from './gate.docs.js';
import * as V from './gate.validation.js';

type Q = Record<string, string | number | boolean | undefined>;
type B = Record<string, unknown>;

const res = (req: FastifyRequest) => ({
  shipments: req.diScope.resolve('gateShipments'),
  entries: req.diScope.resolve('gateEntries'),
  weigh: req.diScope.resolve('gateWeighbridge'),
  passes: req.diScope.resolve('gatePasses'),
  dash: req.diScope.resolve('gateDashboard'),
  appts: req.diScope.resolve('gateAppointments'),
  asn: req.diScope.resolve('gateAsn'),
  sec: req.diScope.resolve('gateSecurity'),
});
const id = (req: FastifyRequest) => (req.params as { id: string }).id;
const q = (req: FastifyRequest) => req.query as Q;
const b = (req: FastifyRequest) => req.body as B;
/** Body handed to a service method (validated by the route schema). */
const body = (req: FastifyRequest): never => req.body as never;
const s = (v: unknown): string | undefined =>
  typeof v === 'string'
    ? v === ''
      ? undefined
      : v
    : typeof v === 'number'
      ? String(v)
      : undefined;
const paging = (x: Q): Paging => ({
  limit: Number(x.limit ?? 20),
  ...(x.cursor === undefined ? {} : { cursor: String(x.cursor) }),
});
const idemKey = (req: FastifyRequest): string | null => {
  const h = req.headers['idempotency-key'];
  const k = Array.isArray(h) ? h[0] : h;
  return k !== undefined && /^[A-Za-z0-9._-]{8,64}$/.test(k) ? k : null;
};
const ifNoneMatch = (req: FastifyRequest): string | undefined => {
  const h: unknown = req.headers['if-none-match'];
  return typeof h === 'string' ? h : undefined;
};

/** ETag'd read: 304 when unchanged, else `{ success, data }` with the ETag. */
const sendCached = async (
  reply: FastifyReply,
  r: { etag: string | null; body: unknown; notModified: boolean },
) => {
  if (r.etag !== null)
    void reply.header('etag', r.etag).header('cache-control', 'private, no-cache');
  if (r.notModified) return reply.code(304).send();
  return reply.send(ok(r.body));
};

const pdf = (reply: FastifyReply, file: Buffer, name: string) =>
  reply
    .header('content-type', 'application/pdf')
    .header('content-disposition', `inline; filename="${name}.pdf"`)
    .header('cache-control', 'private, max-age=60')
    .send(file);

/**
 * D-62 W5 Gate & Weighbridge: warehouse panel `/wms/gate/*` (scoped) and admin `/admin/wms/gate/*`
 * (GLOBAL grants), same handlers. Every write is idempotent per user + route (`Idempotency-Key`)
 * and state-guarded in the service; cached dashboard reads answer 304 to `If-None-Match`.
 */
export const gateRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = gateDocs(aud);
    const r = (key = 'gate.view') => audRead(aud, key);
    const w = (key: string) => audWrite(aud, key);
    const wh = (req: FastifyRequest) => String(q(req).warehouseId);

    // ── lookups ──
    app.get(
      '/gate/lookups',
      { schema: { ...V.whQuery, ...routeDocs(D.lookups) }, preHandler: r() },
      async (req, reply) => {
        void reply.header('cache-control', 'private, max-age=300');
        return ok(await res(req).shipments.lookups(callerOf(req), wh(req)));
      },
    );
    app.get(
      '/gate/bays',
      { schema: { ...V.whQuery, ...routeDocs(D.bays) }, preHandler: r() },
      async (req) => ok(await res(req).shipments.bays(callerOf(req), wh(req))),
    );
    app.get(
      '/gate/scales',
      { schema: { ...V.whQuery, ...routeDocs(D.scales) }, preHandler: r() },
      async (req) => ok(await res(req).weigh.scales(callerOf(req), wh(req))),
    );
    app.get(
      '/gate/purchase-orders',
      { schema: { ...V.purchaseOrdersQuery, ...routeDocs(D.purchaseOrders) }, preHandler: r() },
      async (req) => {
        const x = q(req);
        return ok(
          await res(req).shipments.purchaseOrders(callerOf(req), {
            warehouseId: wh(req),
            limit: Number(x.limit ?? 20),
            ...(s(x.vendorId) === undefined ? {} : { vendorId: String(x.vendorId) }),
            ...(s(x.q) === undefined ? {} : { q: String(x.q) }),
          }),
        );
      },
    );
    app.get(
      '/gate/products',
      { schema: { ...V.productsQuery, ...routeDocs(D.products) }, preHandler: r() },
      async (req) =>
        ok(
          await res(req).shipments.products(
            callerOf(req),
            wh(req),
            String(q(req).q),
            Number(q(req).limit ?? 20),
          ),
        ),
    );

    // ── W5.01 dashboard ──
    app.get(
      '/gate/summary',
      { schema: { ...V.whQuery, ...routeDocs(D.summary) }, preHandler: r() },
      async (req, reply) =>
        sendCached(reply, await res(req).dash.summary(callerOf(req), wh(req), ifNoneMatch(req))),
    );
    app.get(
      '/gate/status-mix',
      { schema: { ...V.whDateQuery, ...routeDocs(D.statusMix) }, preHandler: r() },
      async (req, reply) =>
        sendCached(
          reply,
          await res(req).dash.statusMix(callerOf(req), wh(req), s(q(req).date), ifNoneMatch(req)),
        ),
    );
    app.get(
      '/gate/activity',
      { schema: { ...V.whPageQuery, ...routeDocs(D.activity) }, preHandler: r() },
      async (req) => pageBody(await res(req).dash.activity(callerOf(req), wh(req), paging(q(req)))),
    );
    const listQuery = (x: Q) => ({
      warehouseId: String(x.warehouseId),
      ...(s(x.tab) === undefined ? {} : { tab: x.tab as never }),
      ...(s(x.statuses) === undefined ? {} : { statuses: String(x.statuses) }),
      ...(s(x.q) === undefined ? {} : { q: String(x.q) }),
      ...(s(x.bayId) === undefined ? {} : { bayId: String(x.bayId) }),
      ...(s(x.from) === undefined ? {} : { from: String(x.from) }),
      ...(s(x.to) === undefined ? {} : { to: String(x.to) }),
    });
    app.get(
      '/gate/shipments',
      { schema: { ...V.shipmentsQuery, ...routeDocs(D.shipments) }, preHandler: r() },
      async (req) =>
        pageBody(await res(req).dash.shipments(callerOf(req), listQuery(q(req)), paging(q(req)))),
    );
    app.get(
      '/gate/shipments/counts',
      { schema: { ...V.countsQuery, ...routeDocs(D.counts) }, preHandler: r() },
      async (req, reply) =>
        sendCached(
          reply,
          await res(req).dash.counts(callerOf(req), listQuery(q(req)), ifNoneMatch(req)),
        ),
    );

    // ── W5.02–W5.04 shipments ──
    app.post(
      '/gate/shipments/preview',
      { schema: { ...V.previewSchema, ...routeDocs(D.preview) }, preHandler: w('gate.operate') },
      async (req) => ok(await res(req).shipments.preview(callerOf(req), body(req))),
    );
    app.post(
      '/gate/shipments',
      {
        schema: { ...V.shipmentSchema, ...routeDocs(D.createShipment) },
        preHandler: w('gate.operate'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.shipments.create', 201, () =>
          res(req).shipments.create(callerOf(req), body(req), idemKey(req)),
        ),
    );
    app.get(
      '/gate/shipments/:id',
      { schema: { ...V.idParam, ...routeDocs(D.shipment) }, preHandler: r() },
      async (req) => ok(await res(req).shipments.view(callerOf(req), id(req))),
    );
    app.get(
      '/gate/shipments/:id/lines',
      { schema: { ...V.idParam, ...routeDocs(D.lines) }, preHandler: r() },
      async (req) => ok(await res(req).shipments.lines(callerOf(req), id(req))),
    );
    app.patch(
      '/gate/shipments/:id',
      {
        schema: { ...V.shipmentUpdateSchema, ...routeDocs(D.updateShipment) },
        preHandler: w('gate.operate'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.shipments.update', 200, () =>
          res(req).shipments.update(callerOf(req), id(req), body(req)),
        ),
    );
    app.post(
      '/gate/shipments/:id/cancel',
      {
        schema: { ...V.cancelSchema, ...routeDocs(D.cancelShipment) },
        preHandler: w('gate.operate'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.shipments.cancel', 200, () =>
          res(req).shipments.cancel(callerOf(req), id(req), s(b(req).reason) ?? ''),
        ),
    );
    app.post(
      '/gate/shipments/:id/documents',
      {
        schema: { ...V.attachDocSchema, ...routeDocs(D.attachDoc) },
        preHandler: w('gate.operate'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.documents.attach', 201, () =>
          res(req).shipments.attachDocument(callerOf(req), id(req), body(req)),
        ),
    );
    app.delete(
      '/gate/shipments/:id/documents/:docId',
      { schema: { ...V.docParams, ...routeDocs(D.removeDoc) }, preHandler: w('gate.operate') },
      async (req, reply) => {
        await res(req).shipments.removeDocument(
          callerOf(req),
          id(req),
          (req.params as { docId: string }).docId,
        );
        return reply.code(204).send();
      },
    );
    app.get(
      '/gate/documents/:docId/preview',
      { schema: { ...V.docIdParams, ...routeDocs(D.previewDoc) }, preHandler: r() },
      async (req) =>
        ok(
          await res(req).shipments.previewDocument(
            callerOf(req),
            (req.params as { docId: string }).docId,
          ),
        ),
    );
    app.post(
      '/gate/documents/:docId/verify',
      {
        schema: { ...V.verifyDocSchema, ...routeDocs(D.verifyDoc) },
        preHandler: w('gate.operate'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.documents.verify', 200, () =>
          res(req).entries.verifyDocument(
            callerOf(req),
            (req.params as { docId: string }).docId,
            body(req),
          ),
        ),
    );

    // ── W5.05–W5.08 entries ──
    app.get(
      '/gate/arrivals',
      { schema: { ...V.arrivalsQuery, ...routeDocs(D.arrivals) }, preHandler: r() },
      async (req) =>
        ok(
          await res(req).entries.arrivals(
            callerOf(req),
            wh(req),
            s(q(req).q),
            Number(q(req).limit ?? 20),
          ),
        ),
    );
    app.post(
      '/gate/entries',
      { schema: { ...V.entrySchema, ...routeDocs(D.createEntry) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.create', 201, () =>
          res(req).entries.create(callerOf(req), body(req), idemKey(req)),
        ),
    );
    app.get(
      '/gate/entries',
      { schema: { ...V.entriesQuery, ...routeDocs(D.noReceipt) }, preHandler: r() },
      async (req) => {
        const caller = callerOf(req);
        const warehouseId = wh(req);
        await req.diScope.resolve('gateSupport').warehouse(caller, warehouseId, 'gate.view');
        const rows = await req.diScope
          .resolve('gateRepository')
          .entriesNoReceipt(warehouseId, Number(q(req).limit ?? 20));
        return ok(await Promise.all(rows.map((e) => res(req).entries.out(e.id))));
      },
    );
    app.get(
      '/gate/entries/:id',
      { schema: { ...V.idParam, ...routeDocs(D.entry) }, preHandler: r() },
      async (req) => ok(await res(req).entries.view(callerOf(req), id(req))),
    );
    app.patch(
      '/gate/entries/:id',
      {
        schema: { ...V.entryPatchSchema, ...routeDocs(D.patchEntry) },
        preHandler: w('gate.operate'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.patch', 200, () =>
          res(req).entries.patch(callerOf(req), id(req), body(req)),
        ),
    );
    app.post(
      '/gate/entries/:id/cancel',
      { schema: { ...V.cancelSchema, ...routeDocs(D.cancelEntry) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.cancel', 200, () =>
          res(req).entries.cancel(callerOf(req), id(req), s(b(req).reason) ?? ''),
        ),
    );
    app.get(
      '/gate/entries/:id/documents',
      { schema: { ...V.idParam, ...routeDocs(D.entryDocs) }, preHandler: r() },
      async (req) => ok(await res(req).entries.documents(callerOf(req), id(req))),
    );
    app.post(
      '/gate/entries/:id/approve',
      { schema: { ...V.approveSchema, ...routeDocs(D.approve) }, preHandler: w('gate.approve') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.approve', 200, () =>
          res(req).entries.approve(callerOf(req), id(req), body(req)),
        ),
    );
    app.post(
      '/gate/entries/:id/block',
      { schema: { ...V.blockSchema, ...routeDocs(D.block) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.block', 200, () =>
          res(req).entries.block(callerOf(req), id(req), body(req)),
        ),
    );
    app.post(
      '/gate/entries/:id/unblock',
      { schema: { ...V.remarksSchema, ...routeDocs(D.unblock) }, preHandler: w('gate.approve') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.unblock', 200, () =>
          res(req).entries.unblock(callerOf(req), id(req), s(b(req).remarks) ?? ''),
        ),
    );
    app.post(
      '/gate/entries/:id/turn-away',
      { schema: { ...V.turnAwaySchema, ...routeDocs(D.turnAway) }, preHandler: w('gate.approve') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.turnaway', 200, () =>
          res(req).entries.turnAway(callerOf(req), id(req), body(req)),
        ),
    );
    app.get(
      '/gate/entries/:id/passes',
      { schema: { ...V.idParam, ...routeDocs(D.passes) }, preHandler: r() },
      async (req) => ok(await res(req).passes.passes(callerOf(req), id(req))),
    );
    app.post(
      '/gate/entries/:id/handover',
      { schema: { ...V.emptyBody, ...routeDocs(D.handover) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.handover', 200, () =>
          res(req).entries.handover(callerOf(req), id(req)),
        ),
    );
    app.post(
      '/gate/entries/:id/unloaded',
      { schema: { ...V.unloadedSchema, ...routeDocs(D.unloaded) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.unloaded', 200, () =>
          res(req).entries.unloaded(callerOf(req), id(req), s(b(req).reason) ?? null),
        ),
    );
    app.get(
      '/gate/entries/:id/receipts',
      { schema: { ...V.idParam, ...routeDocs(D.receipts) }, preHandler: r() },
      async (req) => ok(await res(req).entries.receipts(callerOf(req), id(req))),
    );
    app.get(
      '/gate/entries/:id/timeline',
      { schema: { ...V.idParam, ...routeDocs(D.timeline) }, preHandler: r() },
      async (req) => ok(await res(req).entries.timeline(callerOf(req), id(req))),
    );

    // ── passes ──
    app.get(
      '/gate/passes/:passNo/pdf',
      { schema: { ...V.passNoParams, ...routeDocs(D.passPdf) }, preHandler: r() },
      async (req, reply) => {
        const p = await res(req).passes.pdf(
          callerOf(req),
          (req.params as { passNo: string }).passNo,
        );
        return pdf(reply, p.file, p.passNo);
      },
    );
    app.post(
      '/gate/passes/scan',
      { schema: { ...V.scanSchema, ...routeDocs(D.scan) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.passes.scan', 200, () =>
          res(req).passes.scan(callerOf(req), s(b(req).qrToken) ?? ''),
        ),
    );
    app.post(
      '/gate/passes/:passNo/reissue',
      { schema: { ...V.reissueSchema, ...routeDocs(D.reissue) }, preHandler: w('gate.approve') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.passes.reissue', 201, () =>
          res(req).passes.reissue(
            callerOf(req),
            (req.params as { passNo: string }).passNo,
            s(b(req).reason) ?? '',
          ),
        ),
    );

    // ── W5.09 / W5.10 weighbridge ──
    app.get(
      '/gate/weighbridge/lookup',
      { schema: { ...V.lookupQuery, ...routeDocs(D.lookup) }, preHandler: r() },
      async (req) => ok(await res(req).weigh.lookup(callerOf(req), wh(req), String(q(req).regNo))),
    );
    app.get(
      '/gate/entries/:id/weighments',
      { schema: { ...V.idParam, ...routeDocs(D.weighments) }, preHandler: r() },
      async (req) => ok(await res(req).weigh.weighments(callerOf(req), id(req))),
    );
    app.post(
      '/gate/entries/:id/weighments',
      { schema: { ...V.weighSchema, ...routeDocs(D.capture) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.weighments.capture', 201, () =>
          res(req).weigh.capture(callerOf(req), id(req), body(req)),
        ),
    );
    app.get(
      '/gate/entries/:id/reconciliation',
      { schema: { ...V.idParam, ...routeDocs(D.reconciliation) }, preHandler: r() },
      async (req) => ok(await res(req).weigh.reconciliation(callerOf(req), id(req))),
    );
    app.post(
      '/gate/entries/:id/hold',
      { schema: { ...V.holdSchema, ...routeDocs(D.hold) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.hold', 200, () =>
          res(req).weigh.hold(callerOf(req), id(req), s(b(req).note) ?? ''),
        ),
    );
    app.post(
      '/gate/entries/:id/hold/resolve',
      {
        schema: { ...V.resolveSchema, ...routeDocs(D.resolveHold) },
        preHandler: w('gate.approve'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.resolve', 200, () =>
          res(req).weigh.resolveHold(callerOf(req), id(req), body(req)),
        ),
    );
    app.post(
      '/gate/weighments/:id/override',
      { schema: { ...V.overrideSchema, ...routeDocs(D.override) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.weighments.override', 201, () =>
          res(req).weigh.override(callerOf(req), id(req), body(req)),
        ),
    );
    app.post(
      '/gate/weighments/:id/review',
      { schema: { ...V.reviewSchema, ...routeDocs(D.review) }, preHandler: w('gate.approve') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.weighments.review', 200, () =>
          res(req).weigh.review(callerOf(req), id(req), body(req)),
        ),
    );
    app.get(
      '/gate/approvals',
      { schema: { ...V.approvalsQuery, ...routeDocs(D.approvals) }, preHandler: r() },
      async (req) =>
        ok(await res(req).weigh.approvals(callerOf(req), wh(req), Number(q(req).limit ?? 20))),
    );
    app.get(
      '/gate/entries/:id/weighment-slip.pdf',
      { schema: { ...V.idParam, ...routeDocs(D.slipPdf) }, preHandler: r() },
      async (req, reply) => {
        const p = await res(req).passes.slipPdf(callerOf(req), id(req));
        return pdf(reply, p.file, `weighment-${p.entryNo}`);
      },
    );
    app.post(
      '/gate/entries/:id/outward-pass',
      {
        schema: { ...V.outwardPassSchema, ...routeDocs(D.outwardPass) },
        preHandler: w('gate.operate'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.outwardpass', 200, () =>
          res(req).weigh.outwardPass(callerOf(req), id(req), body(req)),
        ),
    );
    app.post(
      '/gate/entries/:id/exit',
      { schema: { ...V.emptyBody, ...routeDocs(D.exit) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.entries.exit', 200, () =>
          res(req).weigh.exit(callerOf(req), id(req)),
        ),
    );

    // ── W5.11 dock appointments ──
    app.get(
      '/gate/appointments/summary',
      { schema: { ...V.whDateQuery, ...routeDocs(D.apptSummary) }, preHandler: r() },
      async (req) => ok(await res(req).appts.summary(callerOf(req), wh(req), s(q(req).date))),
    );
    app.get(
      '/gate/appointments/slots',
      { schema: { ...V.whDateQuery, ...routeDocs(D.apptSlots) }, preHandler: r() },
      async (req) => ok(await res(req).appts.slots(callerOf(req), wh(req), s(q(req).date))),
    );
    app.get(
      '/gate/appointments/bays',
      { schema: { ...V.whDateQuery, ...routeDocs(D.apptBays) }, preHandler: r() },
      async (req) => ok(await res(req).appts.bays(callerOf(req), wh(req), s(q(req).date))),
    );
    app.get(
      '/gate/appointments',
      { schema: { ...V.apptListQuery, ...routeDocs(D.appointments) }, preHandler: r() },
      async (req) => {
        const page = await res(req).appts.list(
          callerOf(req),
          wh(req),
          s(q(req).date),
          paging(q(req)),
        );
        return {
          success: true,
          data: page.items,
          meta: { nextCursor: page.nextCursor, limit: page.limit, total: page.total },
        };
      },
    );
    app.post(
      '/gate/appointments',
      { schema: { ...V.bookSchema, ...routeDocs(D.book) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.appointments.book', 201, () =>
          res(req).appts.book(callerOf(req), body(req)),
        ),
    );
    app.get(
      '/gate/appointments/:id',
      { schema: { ...V.apptQuery, ...routeDocs(D.appointment) }, preHandler: r() },
      async (req) => ok(await res(req).appts.get(callerOf(req), wh(req), id(req))),
    );
    app.patch(
      '/gate/appointments/:id',
      {
        schema: { ...V.rescheduleSchema, ...routeDocs(D.reschedule) },
        preHandler: w('gate.operate'),
      },
      async (req, reply) => {
        const x = req.body as {
          warehouseId: string;
          slotStart: string;
          dockDoorId?: string | null;
        };
        return sendIdempotent(req, reply, 'gate.appointments.reschedule', 200, () =>
          res(req).appts.reschedule(callerOf(req), x.warehouseId, id(req), {
            slotStart: x.slotStart,
            dockDoorId: x.dockDoorId ?? null,
          }),
        );
      },
    );
    app.post(
      '/gate/appointments/:id/confirm',
      { schema: { ...V.apptActionSchema, ...routeDocs(D.confirm) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.appointments.confirm', 200, () =>
          res(req).appts.confirm(callerOf(req), s(b(req).warehouseId) ?? '', id(req)),
        ),
    );
    app.post(
      '/gate/appointments/:id/cancel',
      {
        schema: { ...V.apptCancelSchema, ...routeDocs(D.cancelAppt) },
        preHandler: w('gate.operate'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.appointments.cancel', 200, () =>
          res(req).appts.cancel(
            callerOf(req),
            s(b(req).warehouseId) ?? '',
            id(req),
            s(b(req).reason) ?? '',
          ),
        ),
    );

    // ── W5.12 vendor ASN ──
    app.get(
      '/gate/asns/summary',
      { schema: { ...V.whDateQuery, ...routeDocs(D.asnSummary) }, preHandler: r() },
      async (req) => ok(await res(req).asn.summary(callerOf(req), wh(req), s(q(req).date))),
    );
    app.get(
      '/gate/asns',
      { schema: { ...V.asnListQuery, ...routeDocs(D.asns) }, preHandler: r() },
      async (req) => {
        const x = q(req);
        return pageBody(
          await res(req).asn.list(
            callerOf(req),
            {
              warehouseId: wh(req),
              ...(s(x.status) === undefined ? {} : { status: String(x.status) }),
              ...(s(x.q) === undefined ? {} : { q: String(x.q) }),
              ...(s(x.from) === undefined ? {} : { from: String(x.from) }),
              ...(s(x.to) === undefined ? {} : { to: String(x.to) }),
            },
            paging(x),
          ),
        );
      },
    );
    app.get(
      '/gate/asns/:id',
      { schema: { ...V.idParam, ...routeDocs(D.asn) }, preHandler: r() },
      async (req) => ok(await res(req).asn.get(callerOf(req), id(req))),
    );
    app.post(
      '/gate/asns',
      { schema: { ...V.asnSchema, ...routeDocs(D.createAsn) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.asns.create', 201, () =>
          res(req).asn.create(callerOf(req), body(req)),
        ),
    );
    app.post(
      '/gate/asns/:id/match',
      { schema: { ...V.matchSchema, ...routeDocs(D.match) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.asns.match', 200, () =>
          res(req).asn.match(callerOf(req), id(req), s(b(req).restockRequestId) ?? ''),
        ),
    );
    app.post(
      '/gate/asns/:id/convert',
      { schema: { ...V.convertSchema, ...routeDocs(D.convert) }, preHandler: w('gate.operate') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.asns.convert', 201, () =>
          res(req).asn.convert(callerOf(req), id(req), body(req)),
        ),
    );

    // ── W5.13 visitors & security ──
    app.get(
      '/gate/security/summary',
      { schema: { ...V.whQuery, ...routeDocs(D.secSummary) }, preHandler: r() },
      async (req) => ok(await res(req).sec.summary(callerOf(req), wh(req))),
    );
    app.get(
      '/gate/visitors',
      { schema: { ...V.visitorsQuery, ...routeDocs(D.visitors) }, preHandler: r() },
      async (req) => {
        const x = q(req);
        return pageBody(
          await res(req).sec.visitors(
            callerOf(req),
            {
              warehouseId: wh(req),
              ...(s(x.status) === undefined ? {} : { status: String(x.status) }),
              ...(s(x.date) === undefined ? {} : { date: String(x.date) }),
              ...(s(x.q) === undefined ? {} : { q: String(x.q) }),
            },
            paging(x),
          ),
        );
      },
    );
    app.post(
      '/gate/visitors',
      {
        schema: { ...V.visitorSchema, ...routeDocs(D.createVisitor) },
        preHandler: w('gate.security'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.visitors.create', 201, () =>
          res(req).sec.createVisitor(callerOf(req), body(req)),
        ),
    );
    app.get(
      '/gate/visitors/:id',
      { schema: { ...V.idParam, ...routeDocs(D.visitor) }, preHandler: r() },
      async (req) => ok(await res(req).sec.visitor(callerOf(req), id(req))),
    );
    for (const [path, to] of [
      ['check-in', 'ON_SITE'],
      ['check-out', 'CHECKED_OUT'],
      ['deny', 'DENIED'],
    ] as const)
      app.post(
        `/gate/visitors/:id/${path}`,
        { schema: { ...V.emptyBody, ...routeDocs(D.visitorMove) }, preHandler: w('gate.security') },
        async (req, reply) =>
          sendIdempotent(req, reply, `gate.visitors.${path}`, 200, () =>
            res(req).sec.moveVisitor(callerOf(req), id(req), to),
          ),
      );
    app.get(
      '/gate/outward-materials',
      { schema: { ...V.outwardQuery, ...routeDocs(D.outward) }, preHandler: r() },
      async (req) => {
        const x = q(req);
        return pageBody(
          await res(req).sec.outward(
            callerOf(req),
            {
              warehouseId: wh(req),
              ...(s(x.status) === undefined ? {} : { status: String(x.status) }),
              ...(s(x.date) === undefined ? {} : { date: String(x.date) }),
            },
            paging(x),
          ),
        );
      },
    );
    app.post(
      '/gate/outward-materials',
      {
        schema: { ...V.outwardSchema, ...routeDocs(D.createOutward) },
        preHandler: w('gate.security'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.outward.create', 201, () =>
          res(req).sec.createOutward(callerOf(req), body(req)),
        ),
    );
    for (const [path, to, key] of [
      ['authorize', 'AUTHORIZED', 'gate.approve'],
      ['reject', 'REJECTED', 'gate.approve'],
      ['exit', 'EXITED', 'gate.security'],
    ] as const)
      app.post(
        `/gate/outward-materials/:id/${path}`,
        {
          schema: {
            ...V.noteSchema,
            ...routeDocs(path === 'exit' ? D.exitOutward : D.authorizeOutward),
          },
          preHandler: w(key),
        },
        async (req, reply) =>
          sendIdempotent(req, reply, `gate.outward.${path}`, 200, () =>
            res(req).sec.moveOutward(callerOf(req), id(req), to, s(b(req).note) ?? null),
          ),
      );
    app.get(
      '/gate/security-checks',
      { schema: { ...V.checksQuery, ...routeDocs(D.checks) }, preHandler: r() },
      async (req) => {
        const x = q(req);
        return pageBody(
          await res(req).sec.checks(
            callerOf(req),
            {
              warehouseId: wh(req),
              ...(s(x.result) === undefined ? {} : { result: String(x.result) }),
              ...(x.open === undefined ? {} : { open: x.open === true || x.open === 'true' }),
            },
            paging(x),
          ),
        );
      },
    );
    app.post(
      '/gate/security-checks',
      { schema: { ...V.checkSchema, ...routeDocs(D.createCheck) }, preHandler: w('gate.security') },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.checks.create', 201, () =>
          res(req).sec.createCheck(callerOf(req), body(req)),
        ),
    );
    app.post(
      '/gate/security-checks/:id/resolve',
      {
        schema: { ...V.resolveCheckSchema, ...routeDocs(D.resolveCheck) },
        preHandler: w('gate.approve'),
      },
      async (req, reply) =>
        sendIdempotent(req, reply, 'gate.checks.resolve', 200, () =>
          res(req).sec.resolveCheck(callerOf(req), id(req), body(req)),
        ),
    );
  };
