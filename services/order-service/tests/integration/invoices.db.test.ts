import { createHash, randomUUID } from 'node:crypto';

import { asValue } from 'awilix';
import { extractText, getDocumentProxy } from 'unpdf';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ObjectStore } from '../../src/adapters/object-store.js';
import { requestHash } from '../../src/middleware/http.js';
import {
  SELLER_GSTIN,
  cold,
  confirmedOrder,
  docsOf,
  issue,
  seqOf,
  startInvoiceApp,
  taxed,
} from './invoices.fixtures.js';
import { DB_URL, address, app, placed } from './orders.harness.js';

describe.skipIf(DB_URL === undefined)('invoice core (issue at dispatch, F1 hook)', () => {
  beforeAll(async () => {
    await startInvoiceApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('split shipments: Σ documents = the order to the paisa; freight once; immutable snapshot', async () => {
    const order = await confirmedOrder([
      { variantId: taxed, qty: 3 },
      { variantId: cold, qty: 2 },
    ]);
    const a = await issue(order.id, [
      { lineNo: 1, qty: 1 },
      { lineNo: 2, qty: 1 },
    ]);
    const b = await issue(order.id, [{ lineNo: 1, qty: 2 }]);
    const c = await issue(order.id, [{ lineNo: 2, qty: 1 }]);
    expect([a, b, c].map((d) => d.docType)).toEqual(['TAX_INVOICE', 'TAX_INVOICE', 'TAX_INVOICE']);
    expect(seqOf(b.docNo)).toBe(seqOf(a.docNo) + 1);
    expect(seqOf(c.docNo)).toBe(seqOf(b.docNo) + 1);

    const docs = await docsOf(order.id);
    const total = docs.reduce((acc, d) => acc + d.grandTotalPaise, 0n);
    expect(total).toBe(BigInt(order.totalPaise));
    expect(docs.flatMap((d) => d.lines).filter((l) => l.kind === 'FREIGHT')).toHaveLength(1);
    expect(docs[0]?.lines.map((l) => l.kind)).toEqual(['GOODS', 'GOODS', 'FREIGHT']);
    for (const d of docs) {
      expect(d).toMatchObject({
        supplyType: 'INTRA',
        igstPaise: 0n,
        sellerGstin: SELLER_GSTIN,
        gstr1Section: 'B2CS',
      });
      expect(d.cgstPaise).toBe(d.sgstPaise);
      expect(d.snapshotSha256).toBe(requestHash(d.snapshot));
    }
    expect(docs[0]?.snapshot).toMatchObject({
      seller: { gstin: SELLER_GSTIN, stateName: 'Andhra Pradesh' },
      buyer: { name: 'Sri Lakshmi Poultry', placeOfSupply: '37' },
      payment: { method: 'upi' },
    });

    // Everything is billed now: one more shipment is refused with the reasons.
    await expect(issue(order.id, [{ lineNo: 1, qty: 1 }])).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'INVOICE_INVALID' },
    });
  });

  it('the same shipment issued 10× concurrently → one document, the rest replay it', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 2 }]);
    const shipmentId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => issue(order.id, [{ lineNo: 1, qty: 2 }], shipmentId)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await docsOf(order.id)).toHaveLength(1);
  });

  it('numbers: 8 orders invoiced concurrently get unique, consecutive numbers', async () => {
    const orders = await Promise.all(
      Array.from({ length: 8 }, () => confirmedOrder([{ variantId: taxed, qty: 1 }])),
    );
    const docs = await Promise.all(orders.map((o) => issue(o.id, [{ lineNo: 1, qty: 1 }])));
    const seqs = docs.map((d) => seqOf(d.docNo)).sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(8);
    expect((seqs.at(-1) ?? 0) - (seqs[0] ?? 0)).toBe(7);
  });

  it('sequence: 100 parallel takers → 1..100; a rolled-back taker leaves no gap', async () => {
    const repo = app.diContainer.resolve('invoicesRepository');
    const run = app.diContainer.resolve('runInTransaction');
    const series = `T${randomUUID().slice(0, 6)}`;
    const taken = await Promise.all(
      Array.from({ length: 100 }, () =>
        run((tx) => repo.nextNumber(tx, SELLER_GSTIN, series, '2627')),
      ),
    );
    expect([...taken].sort((x, y) => x - y)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    await expect(
      run(async (tx) => {
        await repo.nextNumber(tx, SELLER_GSTIN, series, '2627');
        throw new Error('dispatch failed');
      }),
    ).rejects.toThrow('dispatch failed');
    expect(await run((tx) => repo.nextNumber(tx, SELLER_GSTIN, series, '2627'))).toBe(101);
  });

  it('inter-state order → IGST only', async () => {
    const original = address.snapshot;
    address.snapshot = (userId: string, addressId: string) =>
      original(userId, addressId).then((a) => ({ ...a, stateCode: '29' }));
    try {
      const order = await confirmedOrder([{ variantId: taxed, qty: 2 }], '29');
      await issue(order.id, [{ lineNo: 1, qty: 2 }]);
      const [doc] = await docsOf(order.id);
      expect(doc).toMatchObject({
        supplyType: 'INTER',
        placeOfSupply: '29',
        cgstPaise: 0n,
        sgstPaise: 0n,
      });
      expect(doc?.igstPaise).toBeGreaterThan(0n);
      expect(doc?.grandTotalPaise).toBe(BigInt(order.totalPaise));
    } finally {
      address.snapshot = original;
    }
  });

  it('only CONFIRMED orders are invoiced', async () => {
    // Placed (not yet confirmed by an admin): no invoice. No DB tampering, so the global
    // recovery jobs other test files exercise never see an inconsistent order.
    const { order } = await placed();
    await expect(issue(order.id, [{ lineNo: 1, qty: 1 }])).rejects.toMatchObject({
      statusCode: 409,
      details: {
        reason: 'INVOICE_INVALID',
        issues: [expect.objectContaining({ path: 'order.status' })],
      },
    });
  });

  it('issued documents are immutable: totals / snapshot / delete refused; PDF status may change', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 1 }]);
    const { id } = await issue(order.id, [{ lineNo: 1, qty: 1 }]);
    const db = app.diContainer.resolve('db');
    await expect(
      db.taxDocument.update({ where: { id }, data: { grandTotalPaise: 1n } }),
    ).rejects.toThrow(/immutable/);
    await expect(db.taxDocument.update({ where: { id }, data: { snapshot: {} } })).rejects.toThrow(
      /immutable/,
    );
    await expect(db.taxDocument.delete({ where: { id } })).rejects.toThrow(/immutable/);
    await expect(db.taxDocumentLine.deleteMany({ where: { documentId: id } })).rejects.toThrow();
    const ok = await db.taxDocument.update({
      where: { id },
      data: { pdfStatus: 'READY', pdfKey: 'k' },
    });
    expect(ok.pdfStatus).toBe('READY');
  });

  // ── PDF rendering (B2) ──

  const docRow = (id: string) =>
    app.diContainer.resolve('db').taxDocument.findUniqueOrThrow({ where: { id } });
  const render = () => app.diContainer.resolve('invoicesService').renderDue();
  const backdate = (id: string, ms: number) =>
    app.diContainer
      .resolve('db')
      .taxDocument.update({ where: { id }, data: { updatedAt: new Date(Date.now() - ms) } });

  it('renders from the snapshot into private storage: READY, SHA-256 of the stored bytes, content', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 1 }]);
    const doc = await issue(order.id, [{ lineNo: 1, qty: 1 }]);
    expect((await docRow(doc.id)).pdfStatus).toBe('PENDING');
    await render();
    const row = await docRow(doc.id);
    expect(row).toMatchObject({
      pdfStatus: 'READY',
      pdfAttempts: 1,
      pdfError: null,
      pdfKey: `invoices/${row.fy}/${doc.docNo.replaceAll('/', '-')}.pdf`,
    });
    const bytes = await app.diContainer.resolve('objectStore').get(row.pdfKey ?? '');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.pdfSha256);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), {
      mergePages: true,
    });
    for (const needle of [doc.docNo, SELLER_GSTIN, '30023000', 'Sri Lakshmi Poultry', 'Rupees'])
      expect(text).toContain(needle);
  }, 60_000);

  it('two renderers in parallel render each document exactly once', async () => {
    const orders = await Promise.all(
      [1, 2, 3].map(() => confirmedOrder([{ variantId: taxed, qty: 1 }])),
    );
    const docs = await Promise.all(orders.map((o) => issue(o.id, [{ lineNo: 1, qty: 1 }])));
    await Promise.all([render(), render()]);
    for (const d of docs)
      expect(await docRow(d.id)).toMatchObject({ pdfStatus: 'READY', pdfAttempts: 1 });
  }, 60_000);

  it('a storage failure backs off and recovers; a crashed renderer is taken over; attempts are capped', async () => {
    const order = await confirmedOrder([{ variantId: taxed, qty: 1 }]);
    const doc = await issue(order.id, [{ lineNo: 1, qty: 1 }]);
    const store = app.diContainer.resolve('objectStore');
    let failNext = true;
    const flaky: ObjectStore = {
      kind: store.kind,
      put: (o) => {
        if (failNext && o.key.includes(doc.docNo.replaceAll('/', '-'))) {
          failNext = false;
          return Promise.reject(new Error('Spaces unavailable'));
        }
        return store.put(o);
      },
      signedUrl: (k, f, t) => store.signedUrl(k, f, t),
      get: (k) => store.get(k),
    };
    app.diContainer.register({ objectStore: asValue(flaky) });
    try {
      await render();
      expect(await docRow(doc.id)).toMatchObject({
        pdfStatus: 'FAILED',
        pdfAttempts: 1,
        pdfError: 'Spaces unavailable',
      });
      await render(); // still inside its backoff (60 s): untouched
      expect((await docRow(doc.id)).pdfAttempts).toBe(1);
      await backdate(doc.id, 2 * 60_000);
      await render();
      expect(await docRow(doc.id)).toMatchObject({
        pdfStatus: 'READY',
        pdfAttempts: 2,
        pdfError: null,
      });
    } finally {
      app.diContainer.register({ objectStore: asValue(store) });
    }

    // A renderer that crashed mid-render (RENDERING for > 5 min) is taken over.
    const db = app.diContainer.resolve('db');
    const stale = await issue((await confirmedOrder([{ variantId: taxed, qty: 1 }])).id, [
      { lineNo: 1, qty: 1 },
    ]);
    await db.taxDocument.update({
      where: { id: stale.id },
      data: {
        pdfStatus: 'RENDERING',
        pdfAttempts: 1,
        updatedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    await render();
    expect(await docRow(stale.id)).toMatchObject({ pdfStatus: 'READY', pdfAttempts: 2 });

    // Out of attempts: stays FAILED until an admin retries it.
    const capped = await issue((await confirmedOrder([{ variantId: taxed, qty: 1 }])).id, [
      { lineNo: 1, qty: 1 },
    ]);
    await db.taxDocument.update({
      where: { id: capped.id },
      data: {
        pdfStatus: 'FAILED',
        pdfAttempts: 6,
        updatedAt: new Date(Date.now() - 24 * 3600_000),
      },
    });
    await render();
    expect(await docRow(capped.id)).toMatchObject({ pdfStatus: 'FAILED', pdfAttempts: 6 });
  }, 60_000);
});
