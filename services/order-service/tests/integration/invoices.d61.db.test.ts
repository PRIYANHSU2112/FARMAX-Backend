import { randomUUID } from 'node:crypto';

import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { linesHash } from '../../src/features/invoices/index.js';
import { cold, confirmedOrder, issue, startInvoiceApp, taxed } from './invoices.fixtures.js';
import { DB_URL, app, call, customer, data, deliver, reason, staff } from './orders.harness.js';

/**
 * D-61: invoice ↔ dispatch saga (internal route), credit notes (void, shortage), immutability
 * hardening, customer downloads, warehouse print source, admin register, races.
 */

interface Line {
  lineNo: number;
  qty: number;
}
const db = () => app.diContainer.resolve('db');
const invoices = () => app.diContainer.resolve('invoicesService');

const gateOut = (orderId: string, shipmentId: string, lines: Line[], hash = linesHash(lines)) =>
  call('POST', `/internal/orders/${orderId}/shipments/${shipmentId}/invoice`, {
    internal: true,
    payload: { lines, linesHash: hash, by: null },
  });

const shipmentEvent = (
  order: { id: string; orderNo: string },
  shipmentId: string,
  status: string,
  version: number,
) =>
  deliver('shipment.status_changed.v1', {
    shipmentId,
    shipmentNo: 'SHP-IT-D61',
    orderId: order.id,
    orderNo: order.orderNo,
    warehouseId: randomUUID(),
    from: null,
    to: status,
    at: new Date().toISOString(),
    orderShipments: [
      { shipmentId, warehouseId: randomUUID(), status, version, deliveredLines: [] },
    ],
  });

const docs = (orderId: string) =>
  db().taxDocument.findMany({ where: { orderId }, orderBy: { issuedAt: 'asc' } });
const creditNotesOf = (invoiceId: string) =>
  db().taxDocument.findMany({ where: { originalDocId: invoiceId, docType: 'CREDIT_NOTE' } });

describe.skipIf(DB_URL === undefined)('D-61 invoices: dispatch saga, credit notes, APIs', () => {
  beforeAll(async () => {
    await startInvoiceApp();
  });
  afterAll(async () => {
    await app.close();
  });

  // ── 1 · Distributed transaction: issue before gate-out ──

  it('internal issue: 10 concurrent gate-outs of one shipment → ONE invoice; forged hash → 409', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 4 }]);
    const shipmentId = randomUUID();
    const lines = [{ lineNo: 1, qty: 4 }];
    const all = await Promise.all(
      Array.from({ length: 10 }, () => gateOut(order.id, shipmentId, lines)),
    );
    for (const r of all) expect(r.statusCode, r.body).toBe(200);
    const bodies = all.map((r) => data<{ docNo: string; replayed: boolean; linesHash: string }>(r));
    expect(new Set(bodies.map((b) => b.docNo)).size).toBe(1);
    expect(bodies.filter((b) => !b.replayed)).toHaveLength(1);
    expect(bodies[0]?.linesHash).toBe(linesHash(lines));
    expect(await docs(order.id)).toHaveLength(1);

    const forged = await gateOut(order.id, shipmentId, lines, '0000000000000000');
    expect(forged.statusCode).toBe(409);
    expect(reason(forged)?.reason).toBe('LINES_HASH_MISMATCH');
    const tooMany = await gateOut(order.id, randomUUID(), [{ lineNo: 1, qty: 1 }]);
    expect(tooMany.statusCode).toBe(409);
    expect(reason(tooMany)?.reason).toBe('INVOICE_INVALID');
  });

  it('amendment before gate-out: old invoice voided by a full credit note, replacement issued, Σ exact', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 5 }]);
    const s = randomUUID();
    const a = data<{ docNo: string; docId: string }>(
      await gateOut(order.id, s, [{ lineNo: 1, qty: 5 }]),
    );
    const r = await gateOut(order.id, s, [{ lineNo: 1, qty: 3 }]);
    expect(r.statusCode, r.body).toBe(200);
    const b = data<{ docNo: string; voidedDocNo: string; replayed: boolean }>(r);
    expect(b).toMatchObject({ voidedDocNo: a.docNo, replayed: false });

    const original = await db().taxDocument.findUniqueOrThrow({ where: { id: a.docId } });
    expect(original.status).toBe('CREDITED');
    const [voidCn] = await creditNotesOf(a.docId);
    expect(voidCn).toMatchObject({
      idempotencyKey: `cn:void:${a.docId}`,
      grandTotalPaise: original.grandTotalPaise,
      taxablePaise: original.taxablePaise,
      cgstPaise: original.cgstPaise,
      sgstPaise: original.sgstPaise,
    });
    // The voided units are billable again: another shipment takes the remaining 2.
    const c = await gateOut(order.id, randomUUID(), [{ lineNo: 1, qty: 2 }]);
    expect(c.statusCode, c.body).toBe(200);
    // Active invoices (net of the void) add up to the order to the paisa.
    const all = await docs(order.id);
    const net = all.reduce(
      (acc, d) => acc + (d.docType === 'CREDIT_NOTE' ? -d.grandTotalPaise : d.grandTotalPaise),
      0n,
    );
    expect(net).toBe(BigInt(order.totalPaise));
  });

  it('after gate-out the invoice never changes: other lines → 409 ALREADY_DISPATCHED; same lines replay', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 3 }]);
    const s = randomUUID();
    await gateOut(order.id, s, [{ lineNo: 1, qty: 3 }]);
    await shipmentEvent(order, s, 'DISPATCHED', 3);
    const changed = await gateOut(order.id, s, [{ lineNo: 1, qty: 2 }]);
    expect(changed.statusCode).toBe(409);
    expect(reason(changed)?.reason).toBe('ALREADY_DISPATCHED');
    const same = await gateOut(order.id, s, [{ lineNo: 1, qty: 3 }]);
    expect(same.statusCode).toBe(200);
    expect(data<{ replayed: boolean }>(same).replayed).toBe(true);
    expect(await docs(order.id)).toHaveLength(1);
  });

  // ── 2 · Credit notes: financial accuracy ──

  it('shortage: credit note issued, refund == credit note to the paisa, idempotent', async () => {
    const order = await confirmedOrder([
      { variantId: taxed, qty: 3 },
      { variantId: cold, qty: 2 },
    ]);
    const s = randomUUID();
    const inv = data<{ docId: string }>(
      await gateOut(order.id, s, [
        { lineNo: 1, qty: 3 },
        { lineNo: 2, qty: 2 },
      ]),
    );
    const body = { shipmentId: s, lines: [{ lineNo: 1, qty: 1 }] };
    const r1 = await call('POST', `/internal/orders/${order.id}/shortage-refund`, {
      internal: true,
      payload: body,
    });
    expect(r1.statusCode, r1.body).toBe(200);
    const out = data<{ amountPaise: number; creditNoteNo: string; sourceRef: string }>(r1);
    const [cn] = await creditNotesOf(inv.docId);
    expect(cn?.docNo).toBe(out.creditNoteNo);
    expect(Number(cn?.grandTotalPaise)).toBe(out.amountPaise);
    const rr = await db().orderRefundRequest.findUniqueOrThrow({
      where: { sourceRef: out.sourceRef },
    });
    expect(Math.round(Number(rr.amount) * 100)).toBe(Number(cn?.grandTotalPaise));
    expect(cn).toMatchObject({
      gstr1Section: 'B2CS',
      reason: 'Units not delivered (short delivery)',
    });
    expect((await db().taxDocument.findUniqueOrThrow({ where: { id: inv.docId } })).status).toBe(
      'PARTIALLY_CREDITED',
    );
    // Freight is never credited for a shortage.
    const cnLines = await db().taxDocumentLine.findMany({ where: { documentId: cn?.id ?? '' } });
    expect(cnLines.map((l) => [l.kind, l.qty])).toEqual([['GOODS', 1]]);

    const r2 = await call('POST', `/internal/orders/${order.id}/shortage-refund`, {
      internal: true,
      payload: body,
    });
    expect(data<{ creditNoteNo: string }>(r2).creditNoteNo).toBe(out.creditNoteNo);
    expect(await creditNotesOf(inv.docId)).toHaveLength(1);
  });

  it('race: shortage credit vs cancel-void on one shipment never over-credits (exactly one note)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const order = await confirmedOrder([{ variantId: taxed, qty: 2 }]);
      const s = randomUUID();
      const inv = data<{ docId: string }>(await gateOut(order.id, s, [{ lineNo: 1, qty: 2 }]));
      await Promise.all([
        call('POST', `/internal/orders/${order.id}/shortage-refund`, {
          internal: true,
          payload: { shipmentId: s, lines: [{ lineNo: 1, qty: 1 }] },
        }),
        shipmentEvent(order, s, 'CANCELLED', 9),
      ]);
      const notes = await creditNotesOf(inv.docId);
      expect(notes).toHaveLength(1);
      const invoice = await db().taxDocument.findUniqueOrThrow({ where: { id: inv.docId } });
      expect(notes[0]?.grandTotalPaise ?? 0n).toBeLessThanOrEqual(invoice.grandTotalPaise);
    }
  });

  it('cancelled shipment → void (event; repeats add nothing); the reconcile job catches a missed event', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 1 }]);
    const s = randomUUID();
    const inv = data<{ docId: string }>(await gateOut(order.id, s, [{ lineNo: 1, qty: 1 }]));
    await shipmentEvent(order, s, 'CANCELLED', 4);
    await shipmentEvent(order, s, 'CANCELLED', 5);
    expect(await creditNotesOf(inv.docId)).toHaveLength(1);

    // Missed event: the state says CANCELLED (status untouched) but nothing voided yet.
    const other = await confirmedOrder([{ variantId: taxed, qty: 1 }]);
    const s2 = randomUUID();
    const inv2 = data<{ docId: string }>(await gateOut(other.id, s2, [{ lineNo: 1, qty: 1 }]));
    await db().order.update({
      where: { id: other.id },
      data: { shipmentStates: { [s2]: { status: 'CANCELLED', version: 1, deliveredLines: [] } } },
    });
    const { voided } = await app.diContainer.resolve('ordersService').reconcileShipmentInvoices();
    expect(voided).toBeGreaterThanOrEqual(1);
    expect(await creditNotesOf(inv2.docId)).toHaveLength(1);
    expect(
      (await app.diContainer.resolve('ordersService').reconcileShipmentInvoices()).voided,
    ).toBe(0);
  });

  // ── 3 · Immutability ──

  it('status only moves forward; a credit note never changes; a stored PDF is final', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 2 }]);
    const s = randomUUID();
    const inv = data<{ docId: string }>(await gateOut(order.id, s, [{ lineNo: 1, qty: 2 }]));
    await shipmentEvent(order, s, 'CANCELLED', 2);
    const [cn] = await creditNotesOf(inv.docId);
    await expect(
      db().taxDocument.update({ where: { id: inv.docId }, data: { status: 'ISSUED' } }),
    ).rejects.toThrow(/only moves forward/);
    await expect(
      db().taxDocument.update({ where: { id: cn?.id ?? '' }, data: { status: 'CREDITED' } }),
    ).rejects.toThrow(/never changes status/);
    await expect(db().taxDocument.delete({ where: { id: cn?.id ?? '' } })).rejects.toThrow(
      /immutable/,
    );
    await invoices().renderDue();
    const ready = await db().taxDocument.findUniqueOrThrow({ where: { id: inv.docId } });
    expect(ready.pdfStatus).toBe('READY');
    await expect(
      db().taxDocument.update({ where: { id: inv.docId }, data: { pdfKey: 'elsewhere.pdf' } }),
    ).rejects.toThrow(/final/);
    await expect(
      db().taxDocument.update({ where: { id: inv.docId }, data: { pdfStatus: 'PENDING' } }),
    ).rejects.toThrow(/never goes back/);
  }, 60_000);

  it('a tampered snapshot is refused before any bytes are served (integrity check)', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 1 }]);
    const doc = await issue(order.id, [{ lineNo: 1, qty: 1 }]);
    const row = await db().taxDocument.findUniqueOrThrow({ where: { id: doc.id } });
    const forged = { ...(row.snapshot as object), amountInWords: 'Rupees One Only' };
    await expect(
      invoices().pdfBytes({
        id: row.id,
        docNo: row.docNo,
        fy: row.fy,
        pdfStatus: 'PENDING',
        pdfKey: null,
        pdfSha256: null,
        snapshot: forged,
        snapshotSha256: row.snapshotSha256,
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  // ── Customer APIs ──

  it('customer: list, 409 + Retry-After while rendering, download, combined PDF; other buyer sees nothing', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 3 }]);
    const user = order.user;
    const empty = await call('GET', `/orders/${order.id}/invoices`, { user });
    expect(data<unknown[]>(empty)).toEqual([]); // before dispatch
    const nothing = await call('GET', `/orders/${order.id}/invoices/combined`, { user });
    expect(nothing.statusCode).toBe(404);

    const a = await issue(order.id, [{ lineNo: 1, qty: 2 }]);
    const b = await issue(order.id, [{ lineNo: 1, qty: 1 }]);
    const list = data<{ docNo: string; grandTotal: string; pdfStatus: string }[]>(
      await call('GET', `/orders/${order.id}/invoices`, { user }),
    );
    expect(list.map((d) => d.docNo)).toEqual([a.docNo, b.docNo]);
    expect(list[0]?.pdfStatus).toBe('PENDING');
    expect(list[0]?.grandTotal).toMatch(/^\d+\.\d{2}$/);

    const early = await call('GET', `/orders/${order.id}/invoices/${a.id}/download`, { user });
    expect(early.statusCode).toBe(409);
    expect(early.headers['retry-after']).toBe('5');
    expect(reason(early)?.reason).toBe('PDF_NOT_READY');

    await invoices().renderDue();
    const dl = await call('GET', `/orders/${order.id}/invoices/${a.id}/download`, { user });
    expect(dl.statusCode, dl.body).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf'); // local store streams (dev)
    expect(dl.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const combined = await call('GET', `/orders/${order.id}/invoices/combined`, { user });
    expect(combined.statusCode).toBe(200);
    const { text } = await extractText(
      await getDocumentProxy(new Uint8Array(combined.rawPayload)),
      {
        mergePages: true,
      },
    );
    expect(text).toContain(a.docNo);
    expect(text).toContain(b.docNo);

    const stranger = customer();
    expect(
      data<unknown[]>(await call('GET', `/orders/${order.id}/invoices`, { user: stranger })),
    ).toEqual([]);
    expect(
      (await call('GET', `/orders/${order.id}/invoices/${a.id}/download`, { user: stranger }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/orders/${order.id}/invoices/combined`, { user: stranger })).statusCode,
    ).toBe(404);
    // Staff tokens are not buyers.
    expect(
      (await call('GET', `/orders/${order.id}/invoices`, { user: staff('invoices.view') }))
        .statusCode,
    ).toBe(403);
  }, 60_000);

  it('warehouse print source: the active invoice of a shipment, rendered even before the job', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 1 }]);
    const s = randomUUID();
    const none = await call('GET', `/internal/orders/${order.id}/invoices/by-shipment/${s}/pdf`, {
      internal: true,
    });
    expect(none.statusCode).toBe(404);
    const inv = data<{ docNo: string }>(await gateOut(order.id, s, [{ lineNo: 1, qty: 1 }]));
    const pdf = await call('GET', `/internal/orders/${order.id}/invoices/by-shipment/${s}/pdf`, {
      internal: true,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['x-document-no']).toBe(inv.docNo);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const noToken = await call('GET', `/internal/orders/${order.id}/invoices/by-shipment/${s}/pdf`);
    expect(noToken.statusCode).toBe(401);
  });

  // ── Admin register ──

  it('admin: search filters, detail with linked notes, audited download, retry rules, CSV export, permissions', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 2 }]);
    const s = randomUUID();
    const inv = data<{ docId: string; docNo: string }>(
      await gateOut(order.id, s, [{ lineNo: 1, qty: 2 }]),
    );
    await call('POST', `/internal/orders/${order.id}/shortage-refund`, {
      internal: true,
      payload: { shipmentId: s, lines: [{ lineNo: 1, qty: 1 }] },
    });
    const finance = staff('invoices.view', 'invoices.export');
    const viewer = staff('invoices.view');

    const byNo = data<{ docNo: string }[]>(
      await call('GET', `/admin/invoices?q=${encodeURIComponent(inv.docNo)}`, { user: viewer }),
    );
    expect(byNo.map((d) => d.docNo)).toEqual([inv.docNo]);
    const byOrder = data<{ docType: string }[]>(
      await call('GET', `/admin/invoices?orderId=${order.id}`, { user: viewer }),
    );
    expect(byOrder.map((d) => d.docType).sort()).toEqual(['CREDIT_NOTE', 'TAX_INVOICE']);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const ranged = await call(
      'GET',
      `/admin/invoices?orderId=${order.id}&from=${today}&to=${today}&docType=CREDIT_NOTE`,
      { user: viewer },
    );
    expect(data<unknown[]>(ranged)).toHaveLength(1);

    const detail = data<{
      lines: unknown[];
      linked: { docType: string }[];
      snapshotSha256: string;
    }>(await call('GET', `/admin/invoices/${inv.docId}`, { user: viewer }));
    expect(detail.lines).toHaveLength(1);
    expect(detail.linked.map((l) => l.docType)).toEqual(['CREDIT_NOTE']);

    const notReady = await call('GET', `/admin/invoices/${inv.docId}/download`, { user: viewer });
    expect(notReady.statusCode).toBe(409);
    await invoices().renderDue();
    const dl = await call('GET', `/admin/invoices/${inv.docId}/download`, { user: viewer });
    expect(dl.statusCode).toBe(200);
    const audit = await db().orderAuditLog.findMany({
      where: { targetType: 'tax_document', targetId: inv.docId, action: 'invoices.downloaded' },
    });
    expect(audit).toHaveLength(1);

    const retry = await call('POST', `/admin/invoices/${inv.docId}/pdf/retry`, {
      user: viewer,
      payload: { reason: 'Storage outage resolved' },
    });
    expect(retry.statusCode).toBe(409);
    expect(reason(retry)?.reason).toBe('NOT_FAILED');

    const csv = await call('GET', `/admin/invoices/export.csv?from=${today}&to=${today}`, {
      user: finance,
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\r\n')[0]).toMatch(/^Document type,Document no,/);
    expect(csv.body).toContain(inv.docNo);
    expect(csv.body).toContain(`CREDIT_NOTE,`);

    const tooLong = await call('GET', `/admin/invoices/export.csv?from=2026-01-01&to=2026-03-15`, {
      user: finance,
    });
    expect(tooLong.statusCode).toBe(422);
    expect(
      (await call('GET', `/admin/invoices/export.csv?from=${today}&to=${today}`, { user: viewer }))
        .statusCode,
    ).toBe(403);
    expect((await call('GET', '/admin/invoices', { user: staff('orders.view') })).statusCode).toBe(
      403,
    );
    expect((await call('GET', '/admin/invoices', { user: order.user })).statusCode).toBe(403);
  }, 60_000);

  it('register reads stay fast (p95 of 40 searches < 50 ms, indexed)', async () => {
    const viewer = staff('invoices.view');
    const times: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const t0 = performance.now();
      const r = await call('GET', '/admin/invoices?limit=50', { user: viewer });
      times.push(performance.now() - t0);
      expect(r.statusCode).toBe(200);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length * 0.95)] ?? 0).toBeLessThan(50);
  });

  it('issued documents keep using the per-shipment generation key (no collision when quantities flip back)', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 3 }]);
    const s = randomUUID();
    for (const qty of [3, 2, 3]) {
      const r = await gateOut(order.id, s, [{ lineNo: 1, qty }]);
      expect(r.statusCode, r.body).toBe(200);
    }
    const all = await docs(order.id);
    const active = all.filter((d) => d.docType !== 'CREDIT_NOTE' && d.status !== 'CREDITED');
    expect(active).toHaveLength(1);
    expect(all.filter((d) => d.docType === 'CREDIT_NOTE')).toHaveLength(2);
    expect(new Set(all.map((d) => d.idempotencyKey)).size).toBe(all.length);
  });
});
