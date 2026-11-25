import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { confirmedOrder, issue, startInvoiceApp, taxed } from '../integration/invoices.fixtures.js';
import { DB_URL, app, staff } from '../integration/orders.harness.js';

/**
 * D-61 load benchmark (`ORDER_IT_DATABASE_URL=… pnpm bench:invoices`): real HTTP on a local
 * port against the local Postgres. Seeds 20 orders × 5 invoices (rendered), then drives the
 * read APIs with autocannon and gates on latency. Results → tests/perf/invoices.perf.json.
 *
 * Gate: read APIs p97.5 < 50 ms (stricter than p95) at the stated rate. The download is
 * rate-limited per buyer (30 / min) by design, so it is measured below that limit.
 */
const ORDERS = 20;
const PER_ORDER = 5;

interface Seeded {
  orderId: string;
  user: string;
  docIds: string[];
}

const exec = promisify(execFile);
let base = '';
const seeded: Seeded[] = [];
const results: Record<string, unknown> = {};

interface LoadResult {
  requests: number;
  rps: number;
  non2xx: number;
  errors: number;
  latency: { p50: number; p90: number; p97_5: number; p99: number; max: number };
}

/**
 * Drives the server from a SEPARATE process (tests/perf/load.mjs): no shared event loop.
 * `rate` null = closed loop (each connection sends its next request as soon as the last one
 * answers): measures the capacity of one instance at that concurrency, without the per-second
 * bursts a capped rate produces.
 */
const run = async (
  name: string,
  rate: number | null,
  seconds: number,
  next: (i: number) => { path: string; user: string },
  connections = 20,
): Promise<LoadResult> => {
  const targets = Array.from({ length: 200 }, (_, i) => next(i));
  const cfg = join(tmpdir(), `farmx-load-${randomUUID()}.json`);
  writeFileSync(cfg, JSON.stringify({ url: base, rate, seconds, connections, targets }));
  const { stdout } = await exec(process.execPath, [
    fileURLToPath(new URL('./load.mjs', import.meta.url)),
    cfg,
  ]);
  const res = JSON.parse(stdout) as LoadResult;
  results[name] = { rate, seconds, ...res, latencyMs: res.latency };
  return res;
};

describe.skipIf(DB_URL === undefined)('invoice read APIs under load', () => {
  beforeAll(async () => {
    await startInvoiceApp();
    for (let o = 0; o < ORDERS; o += 1) {
      const order = await confirmedOrder([{ variantId: taxed, qty: PER_ORDER }]);
      const docIds: string[] = [];
      for (let d = 0; d < PER_ORDER; d += 1)
        docIds.push((await issue(order.id, [{ lineNo: 1, qty: 1 }], randomUUID())).id);
      seeded.push({ orderId: order.id, user: order.user, docIds });
    }
    await app.diContainer.resolve('invoicesService').renderDue();
    await app.diContainer.resolve('invoicesService').renderDue();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    writeFileSync(
      new URL('./invoices.perf.json', import.meta.url),
      `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`,
    );
    await app.close();
  });

  const pick = (i: number) => seeded[i % seeded.length]!;
  const viewer = staff('invoices.view');

  /** Endpoints under test: path + caller per request index. */
  const ENDPOINTS = {
    'customer list': (i: number) => {
      const s = pick(i);
      return { path: `/orders/${s.orderId}/invoices`, user: s.user };
    },
    'admin register': () => ({ path: '/admin/invoices?limit=50', user: viewer }),
    'admin register by order': (i: number) => ({
      path: `/admin/invoices?orderId=${pick(i).orderId}`,
      user: viewer,
    }),
    'customer download': (i: number) => {
      const s = pick(i);
      return {
        path: `/orders/${s.orderId}/invoices/${s.docIds[i % PER_ORDER] ?? ''}/download`,
        user: s.user,
      };
    },
    'customer combined PDF': (i: number) => {
      const s = pick(i);
      return { path: `/orders/${s.orderId}/invoices/combined`, user: s.user };
    },
  } as const;

  // 1 · Service time: one request at a time (no queueing) — the latency a user sees.
  //     The combined PDF run is 20 requests over 20 orders: every one is a FIRST download
  //     (cache miss, full render of 5 documents). Target 200 ms; gated at 300 ms as a regression
  //     guard because the cold-render tail on a dev laptop sits right at ~200 ms (see D-61).
  it.each([
    ['customer list', 20, 15, 50],
    ['admin register', 20, 15, 50],
    ['admin register by order', 20, 15, 50],
    ['customer download', 5, 15, 50], // per-buyer limit 30 / min (20 buyers)
    ['customer combined PDF', 2, 10, 300],
  ] as const)(
    'service time: %s at %i rps for %i s, 1 connection → p97.5 < %i ms',
    async (name, rate, seconds, gate) => {
      const res = await run(`${name} · service time`, rate, seconds, ENDPOINTS[name], 1);
      expect(res.non2xx).toBe(0);
      expect(res.latency.p97_5).toBeLessThan(gate);
    },
  );

  // 2 · Capacity of ONE Node process, closed loop at concurrency 4 (production runs several
  //     replicas behind the gateway). Gate: p97.5 < 50 ms AND at least 200 req/s per instance.
  it.each([
    ['customer list', 50, 200],
    ['admin register by order', 50, 200],
    ['admin register', 50, 150],
  ] as const)(
    'one instance: %s, 4 concurrent clients → p97.5 < %i ms and ≥ %i req/s',
    async (name, gate, minRps) => {
      const res = await run(`${name} · capacity (4 clients)`, null, 10, ENDPOINTS[name], 4);
      expect(res.non2xx).toBe(0);
      expect(res.latency.p97_5).toBeLessThan(gate);
      expect(res.rps).toBeGreaterThanOrEqual(minRps);
    },
  );

  // 3 · Combined PDF repeat downloads (LRU hit), 2 concurrent clients.
  it('combined PDF capacity (cache hits) → p97.5 < 200 ms', async () => {
    const res = await run(
      'customer combined PDF · repeat (2 clients, 3 rps)',
      3,
      15,
      ENDPOINTS['customer combined PDF'],
      2,
    );
    expect(res.non2xx).toBe(0);
    expect(res.latency.p97_5).toBeLessThan(200);
  });
});
