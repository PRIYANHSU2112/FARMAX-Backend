/**
 * Wallet load test (D-54 W6). Runs against a RUNNING stack (gateway + auth + payment + wallet,
 * mock gateway, never production) and checks the money afterwards.
 *
 *   GATEWAY_URL=http://127.0.0.1:3100 WALLET_URL=http://127.0.0.1:3112 \
 *   INTERNAL_SERVICE_TOKEN=… ADMIN_TOKEN=… CUSTOMERS=10 \
 *   node --import tsx scripts/load.ts
 *
 * Scenarios (each prints count, errors by status, p50 / p95 / p99 / max, throughput):
 *   S1 reads      CUSTOMERS × 40 GET /v1/wallet + /transactions + /rewards, 50 in flight
 *   S2 top-ups    every customer starts 5 top-ups at once, pays (mock) and verifies
 *   S3 hot wallet 300 parallel checkout debits on ONE wallet that can pay exactly 100
 *   S4 mixed      checkout debits racing points conversions on the same wallets
 * Then: per-customer balance == SUM(postings) is checked by the ledger check (0 findings).
 */
import { randomUUID } from 'node:crypto';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:3100';
const WALLET = process.env.WALLET_URL ?? 'http://127.0.0.1:3112';
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? '';
const ADMIN = process.env.ADMIN_TOKEN ?? '';
const CUSTOMERS = Number(process.env.CUSTOMERS ?? 10);
const OTP = process.env.OTP_DEV_CODE ?? '123456';

interface Res {
  status: number;
  body: {
    success?: boolean;
    data?: unknown;
    error?: { code?: string; details?: { reason?: string } };
  };
  ms: number;
}

const call = async (
  url: string,
  o: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> => {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: o.method ?? 'GET',
    headers: {
      ...(o.token === undefined ? {} : { authorization: `Bearer ${o.token}` }),
      ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...o.headers,
    },
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });
  const body = (await res.json().catch(() => ({}))) as Res['body'];
  return { status: res.status, body, ms: performance.now() - t0 };
};

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed reads of a response
const data = <T>(r: Res): T => r.body.data as T;

/** Runs `n` tasks with at most `limit` in flight; returns every result. */
const pool = async <T>(n: number, limit: number, task: (i: number) => Promise<T>): Promise<T[]> => {
  const out: T[] = new Array<T>(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, n) }, async () => {
      for (let i = next++; i < n; i = next++) out[i] = await task(i);
    }),
  );
  return out;
};

const report = (name: string, results: Res[], wallMs: number) => {
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))] ?? 0;
  const byStatus = new Map<string, number>();
  for (const r of results) {
    const key = `${String(r.status)}${r.body.error?.details?.reason === undefined ? '' : `:${r.body.error.details.reason}`}`;
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
  }
  log(
    `${name.padEnd(34)} n=${String(results.length).padStart(4)}  ` +
      `p50=${q(50).toFixed(0)}ms p95=${q(95).toFixed(0)}ms p99=${q(99).toFixed(0)}ms max=${(ms.at(-1) ?? 0).toFixed(0)}ms  ` +
      `${(results.length / (wallMs / 1000)).toFixed(0)} req/s  ` +
      [...byStatus].map(([k, v]) => `${k}×${String(v)}`).join(' '),
  );
};

const timed = async (name: string, work: () => Promise<Res[]>) => {
  const t0 = performance.now();
  const results = await work();
  report(name, results, performance.now() - t0);
  return results;
};

/** Script output (stdout; no console in this codebase). */
const log = (line: string) =>
  process.stdout.write(`${line}
`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real customer through OTP login (dev OTP code). */
const customer = async (): Promise<{ token: string; userId: string }> => {
  const phone = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  await call(`${GATEWAY}/v1/auth/auth/otp/send`, { method: 'POST', body: { phone } });
  const v = await call(`${GATEWAY}/v1/auth/auth/otp/verify`, {
    method: 'POST',
    body: { phone, code: OTP },
  });
  const token = data<{ accessToken: string }>(v).accessToken;
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
    sub: string;
  };
  return { token, userId: payload.sub };
};

/** Start → mock pay → verify; returns the top-up id. */
const topUp = async (token: string, amountPaise: number): Promise<Res> => {
  const start = await call(`${GATEWAY}/v1/wallet/topups`, {
    method: 'POST',
    token,
    body: { amountPaise, method: 'UPI' },
    headers: { 'idempotency-key': `load-${randomUUID()}` },
  });
  if (start.status !== 200) return start;
  const { topup, checkout } = data<{ topup: { id: string }; checkout: { paymentId: string } }>(
    start,
  );
  const cb = await call(`${GATEWAY}/v1/payments/${checkout.paymentId}/mock/succeed`, {
    method: 'POST',
    token,
    body: { method: 'upi' },
  });
  await call(`${GATEWAY}/v1/payments/${checkout.paymentId}/verify`, {
    method: 'POST',
    token,
    body: cb.body.data,
  });
  return { ...start, body: { data: { id: topup.id } } };
};

const debit = (userId: string, amountPaise: number) =>
  call(`${WALLET}/internal/wallet/debits`, {
    method: 'POST',
    headers: { 'x-internal-token': TOKEN },
    body: {
      paymentId: randomUUID(),
      userId,
      orderId: randomUUID(),
      orderNo: 'ORD-26-LOAD001',
      amountPaise,
    },
  });

const main = async () => {
  log(`wallet load test → ${GATEWAY} (${String(CUSTOMERS)} customers)\n`);
  const people = await pool(CUSTOMERS, 5, () => customer());

  // ── S2: parallel top-ups (5 per customer at once) ──
  const tops = await timed('S2 top-up start+pay+verify', () =>
    pool(CUSTOMERS * 5, 50, (i) => topUp(people[i % CUSTOMERS]?.token ?? '', 1_000_000)),
  );
  await sleep(3_500); // the status read re-checks the gateway after 3 s
  await timed('S2 top-up status (live check)', () =>
    pool(tops.length, 50, (i) => {
      const id = (tops[i]?.body.data as { id?: string } | undefined)?.id ?? randomUUID();
      return call(`${GATEWAY}/v1/wallet/topups/${id}`, { token: people[i % CUSTOMERS]?.token });
    }),
  );

  // First-UPI-top-up cashback must be granted exactly once per customer (5 top-ups raced).
  const pts = await Promise.all(
    people.map(
      async (p) =>
        data<{ availablePts: number }>(await call(`${GATEWAY}/v1/rewards`, { token: p.token }))
          .availablePts,
    ),
  );
  log(`   → cashback points per customer: ${[...new Set(pts)].join(', ')} (expected 500 each)`);

  // ── S1: reads ──
  await timed('S1 reads (wallet/transactions/rewards)', () =>
    pool(CUSTOMERS * 40, 50, (i) => {
      const p = people[i % CUSTOMERS];
      const path = ['/v1/wallet', '/v1/wallet/transactions?limit=20', '/v1/rewards'][i % 3] ?? '';
      return call(`${GATEWAY}${path}`, { token: p?.token });
    }),
  );

  // ── S3: one hot wallet, 300 parallel debits, room for exactly 100 ──
  const hot = people[0];
  if (hot !== undefined) {
    const balance = data<{ balancePaise: number }>(
      await call(`${GATEWAY}/v1/wallet`, { token: hot.token }),
    ).balancePaise;
    const each = Math.floor(balance / 100);
    const s3 = await timed('S3 hot wallet: 300 debits (fits 100)', () =>
      Promise.all(Array.from({ length: 300 }, () => debit(hot.userId, each))),
    );
    const ok = s3.filter((r) => r.status === 200).length;
    const busy = s3.filter((r) => r.status === 503).length;
    const after = data<{ balancePaise: number }>(
      await call(`${GATEWAY}/v1/wallet`, { token: hot.token }),
    ).balancePaise;
    log(
      `   → paid ${String(ok)} (expected ≤ 100; ${String(busy)} answered 503 WALLET_BUSY — safe to retry), balance ${String(balance)} → ${String(after)} (= ${String(balance - ok * each)}: ${String(after === balance - ok * each)})`,
    );
  }

  // ── S4: debits racing conversions on the same wallets ──
  const setMin = (value: number) =>
    call(`${GATEWAY}/v1/admin/wallet/settings/pointsMinConvert`, {
      method: 'PUT',
      token: ADMIN,
      body: { value, reason: 'Load test: allow small conversions (restored right after)' },
    });
  if (ADMIN !== '') await setMin(100);
  await timed('S4 mixed debits + conversions', () =>
    pool(CUSTOMERS * 6, 30, (i) => {
      const p = people[i % CUSTOMERS];
      if (p === undefined) return call(`${GATEWAY}/health`);
      return i % 2 === 0
        ? debit(p.userId, 1_000)
        : call(`${GATEWAY}/v1/rewards/convert`, {
            method: 'POST',
            token: p.token,
            body: { points: 100 },
            headers: { 'idempotency-key': `load-cv-${randomUUID()}` },
          });
    }),
  );

  if (ADMIN !== '') await setMin(1_000);

  // ── Money check ──
  if (ADMIN !== '') {
    const run = await call(`${GATEWAY}/v1/admin/wallet/ledger-checks/run`, {
      method: 'POST',
      token: ADMIN,
    });
    log(`\nledger check: ${JSON.stringify(run.body.data)} (open must be 0)`);
  }
};

await main();
