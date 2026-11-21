import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB_URL, buildTestApp, call, customer, data, errorOf, post } from './harness.js';

let app: FastifyInstance;

interface Tx {
  id: string;
  kind: string;
  category: string;
  direction: string;
  amountPaise: number;
  title: string;
  statusLabel: string;
  balanceAfterPaise: number | null;
}

/** A customer with: top-up ₹500, purchase −₹125, refund +₹50 (oldest → newest). */
const history = async () => {
  const user = customer();
  await post(app, {
    userId: user,
    kind: 'TOPUP',
    category: 'TOPUPS',
    amountPaise: 50_000n,
    counterparty: 'GATEWAY_CLEARING',
    title: 'Wallet Money Added',
  });
  await post(app, {
    userId: user,
    kind: 'ORDER_DEBIT',
    category: 'PURCHASES',
    direction: 'DEBIT',
    amountPaise: 12_500n,
    counterparty: 'ORDER_SETTLEMENT',
    title: 'Used at Checkout',
    subtitle: 'ORD-26-0091857',
  });
  await post(app, {
    userId: user,
    kind: 'REFUND_CREDIT',
    category: 'REFUNDS',
    amountPaise: 5_000n,
    counterparty: 'ORDER_SETTLEMENT',
    title: 'Refund',
  });
  return user;
};

describe.skipIf(DB_URL === undefined)('wallet history and statements (D-54 W5)', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('transactions: newest first, signed amounts, status words, balance after each', async () => {
    const user = await history();
    const list = data<Tx[]>(await call(app, 'GET', '/wallet/transactions', { user }));
    expect(list.map((t) => [t.kind, t.amountPaise, t.statusLabel, t.balanceAfterPaise])).toEqual([
      ['REFUND_CREDIT', 5_000, 'Refunded', 42_500],
      ['ORDER_DEBIT', -12_500, 'Completed', 37_500],
      ['TOPUP', 50_000, 'Wallet Added', 50_000],
    ]);
  });

  it('filters by chip, pages with a cursor, counts per chip', async () => {
    const user = await history();
    const refunds = data<Tx[]>(
      await call(app, 'GET', '/wallet/transactions?category=REFUNDS', { user }),
    );
    expect(refunds.map((t) => t.kind)).toEqual(['REFUND_CREDIT']);

    const first = await call(app, 'GET', '/wallet/transactions?limit=2', { user });
    const meta = first.json<{ meta: { nextCursor: string | null } }>().meta;
    expect(data<Tx[]>(first)).toHaveLength(2);
    expect(meta.nextCursor).not.toBeNull();
    const second = data<Tx[]>(
      await call(app, 'GET', `/wallet/transactions?limit=2&cursor=${meta.nextCursor ?? ''}`, {
        user,
      }),
    );
    expect(second.map((t) => t.kind)).toEqual(['TOPUP']);

    expect(data(await call(app, 'GET', '/wallet/transactions/summary', { user }))).toEqual({
      all: 3,
      byCategory: { TOPUPS: 1, PURCHASES: 1, REFUNDS: 1, REWARDS: 0, ADJUSTMENTS: 0 },
    });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      data<{ all: number }>(
        await call(app, 'GET', `/wallet/transactions/summary?from=${future}`, { user }),
      ).all,
    ).toBe(0);
  });

  it('one transaction: own only (404 for another customer)', async () => {
    const user = await history();
    const [t] = data<Tx[]>(await call(app, 'GET', '/wallet/transactions?limit=1', { user }));
    expect(
      (await call(app, 'GET', `/wallet/transactions/${t?.id ?? ''}`, { user })).statusCode,
    ).toBe(200);
    expect(
      (await call(app, 'GET', `/wallet/transactions/${t?.id ?? ''}`, { user: customer() }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(app, 'GET', `/wallet/transactions/${randomUUID()}`, { user })).statusCode,
    ).toBe(404);
  });

  it('statement PDF for the wallet and the points ledger; range rules', async () => {
    const user = await history();
    const res = await call(app, 'GET', '/wallet/statement', { user });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="farmx-wallet-statement-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf"$/,
    );
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const points = await call(app, 'GET', '/wallet/statement?ledger=POINTS', { user });
    expect(points.headers['content-type']).toBe('application/pdf');

    const tooLong = await call(app, 'GET', '/wallet/statement?from=2024-01-01&to=2026-11-21', {
      user,
    });
    expect(errorOf(tooLong).details?.reason).toBe('RANGE_TOO_LONG');
    const backwards = await call(app, 'GET', '/wallet/statement?from=2026-11-21&to=2026-11-01', {
      user,
    });
    expect(errorOf(backwards).details?.reason).toBe('BAD_RANGE');
    expect((await call(app, 'GET', '/wallet/statement?from=21-11-2026', { user })).statusCode).toBe(
      422,
    );
  });
});
