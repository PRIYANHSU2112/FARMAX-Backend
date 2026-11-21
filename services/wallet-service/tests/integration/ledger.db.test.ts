import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  customer,
  data,
  ledgerOf,
  post,
  reasonOf,
  staff,
} from './harness.js';

let app: FastifyInstance;
const db = () => app.diContainer.resolve('db');

/** Settles every promise; counts fulfilled and rejected-by-reason. */
const settle = async (work: Promise<unknown>[]) => {
  const results = await Promise.allSettled(work);
  const reasons = new Map<string, number>();
  let ok = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') ok += 1;
    else {
      const reason = reasonOf(r.reason) ?? (r.reason as Error).message;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  return { ok, reasons };
};

/** What a real client does on 503 WALLET_BUSY: retry the SAME request (same idempotency key). */
const withRetry = async <T>(work: () => Promise<T>, attempts = 5): Promise<T> => {
  for (let i = 1; ; i += 1) {
    try {
      return await work();
    } catch (err) {
      if (reasonOf(err) !== 'WALLET_BUSY' || i >= attempts) throw err;
    }
  }
};

describe.skipIf(DB_URL === undefined)('wallet ledger against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('credits a new customer: account, two balanced postings, outbox event', async () => {
    const user = customer();
    const r = await post(app, { userId: user, amountPaise: 1_000_000n });
    expect(r.replayed).toBe(false);
    expect(r.balanceAfterPaise).toBe(1_000_000n);
    expect(r.journal.journalNo).toMatch(/^WJ-\d{6}-[0-9A-F]{8}$/);

    const postings = await db().walletPosting.findMany({ where: { journalId: r.journal.id } });
    expect(postings).toHaveLength(2);
    expect(postings.reduce((s, p) => s + p.amountPaise, 0n)).toBe(0n);

    expect(await ledgerOf(app, user)).toEqual({
      balance: 1_000_000n,
      postingsSum: 1_000_000n,
      journals: 1,
      unbalanced: 0,
    });
    const events = await db().outboxEvent.findMany({
      where: { type: 'wallet.transaction_posted.v1' },
    });
    expect(events.some((e) => JSON.stringify(e.payload).includes(r.journal.id))).toBe(true);
  });

  it('replays the same key without moving money, and refuses the key for another movement', async () => {
    const user = customer();
    const key = `it:${randomUUID()}`;
    const first = await post(app, { userId: user, idempotencyKey: key, amountPaise: 50_000n });
    const again = await post(app, { userId: user, idempotencyKey: key, amountPaise: 50_000n });
    expect(again.replayed).toBe(true);
    expect(again.journal.id).toBe(first.journal.id);
    expect(again.balanceAfterPaise).toBe(50_000n);

    await expect(
      post(app, { userId: user, idempotencyKey: key, amountPaise: 60_000n }),
    ).rejects.toMatchObject({ details: { reason: 'IDEMPOTENCY_KEY_REUSED' } });
    await expect(
      post(app, { userId: user, idempotencyKey: key, amountPaise: 50_000n, direction: 'DEBIT' }),
    ).rejects.toMatchObject({ details: { reason: 'IDEMPOTENCY_KEY_REUSED' } });
    expect((await ledgerOf(app, user)).balance).toBe(50_000n);
  });

  it('refuses a debit above the balance and leaves no trace', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 1_000n });
    await expect(
      post(app, {
        userId: user,
        kind: 'ORDER_DEBIT',
        category: 'PURCHASES',
        direction: 'DEBIT',
        counterparty: 'ORDER_SETTLEMENT',
        amountPaise: 1_001n,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'INSUFFICIENT_BALANCE', availablePaise: 1_000, requiredPaise: 1_001 },
    });
    expect(await ledgerOf(app, user)).toMatchObject({ balance: 1_000n, journals: 1 });
  });

  it('a frozen wallet refuses debits but still receives credits', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 5_000n });
    await db().walletAccount.update({
      where: { userId: user },
      data: { status: 'FROZEN', frozenReason: 'test', frozenAt: new Date() },
    });
    await expect(
      post(app, { userId: user, direction: 'DEBIT', amountPaise: 100n }),
    ).rejects.toMatchObject({ details: { reason: 'ACCOUNT_FROZEN' } });
    const credit = await post(app, { userId: user, amountPaise: 100n });
    expect(credit.balanceAfterPaise).toBe(5_100n);
  });

  it('200 parallel debits against a balance for 50: exactly 50 land, nothing goes negative', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 5_000n });
    const { ok, reasons } = await settle(
      Array.from({ length: 200 }, () => {
        const idempotencyKey = `it:${randomUUID()}`;
        return withRetry(() =>
          post(app, {
            userId: user,
            idempotencyKey,
            kind: 'ORDER_DEBIT',
            category: 'PURCHASES',
            direction: 'DEBIT',
            counterparty: 'ORDER_SETTLEMENT',
            amountPaise: 100n,
          }),
        );
      }),
    );
    expect(ok).toBe(50);
    expect(reasons.get('INSUFFICIENT_BALANCE')).toBe(150);
    expect(await ledgerOf(app, user)).toEqual({
      balance: 0n,
      postingsSum: 0n,
      journals: 51,
      unbalanced: 0,
    });
  }, 60_000);

  it('100 parallel requests with ONE key move the money once', async () => {
    const user = customer();
    const key = `it:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        withRetry(() => post(app, { userId: user, idempotencyKey: key, amountPaise: 7_700n })),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.journal.id)).size).toBe(1);
    expect(await ledgerOf(app, user)).toEqual({
      balance: 7_700n,
      postingsSum: 7_700n,
      journals: 1,
      unbalanced: 0,
    });
  }, 60_000);

  it('a wallet locked longer than lock_timeout answers 503 WALLET_BUSY and moves nothing', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 1_000n });
    // Another transaction holds the account row for 4 s (> the 3 s lock_timeout).
    const holder = db().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "wallet_accounts" WHERE "userId" = ${user}::uuid FOR UPDATE`;
        await tx.$executeRaw`SELECT pg_sleep(4)`;
      },
      { timeout: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(
      post(app, { userId: user, direction: 'DEBIT', amountPaise: 100n }),
    ).rejects.toMatchObject({
      statusCode: 503,
      details: { reason: 'WALLET_BUSY' },
    });
    await holder;
    expect(await ledgerOf(app, user)).toMatchObject({ balance: 1_000n, journals: 1 });
  }, 20_000);

  describe('database invariants (even code that bypasses the service cannot break them)', () => {
    it('journals and postings are append-only', async () => {
      const user = customer();
      const r = await post(app, { userId: user });
      await expect(
        db().walletJournal.update({ where: { id: r.journal.id }, data: { title: 'edited' } }),
      ).rejects.toThrow();
      await expect(
        db().walletPosting.deleteMany({ where: { journalId: r.journal.id } }),
      ).rejects.toThrow();
      await expect(db().walletAccount.delete({ where: { userId: user } })).rejects.toThrow();
    });

    it('a balance cannot change without a matching posting', async () => {
      const user = customer();
      await post(app, { userId: user, amountPaise: 1_000n });
      await expect(
        db().walletAccount.update({ where: { userId: user }, data: { balancePaise: 999_999n } }),
      ).rejects.toThrow(/does not match its ledger/);
      expect((await ledgerOf(app, user)).balance).toBe(1_000n);
    });

    it('a journal must balance to zero and a posting must continue the chain', async () => {
      const user = customer();
      const r = await post(app, { userId: user, amountPaise: 1_000n });
      const account = await db().walletAccount.findUniqueOrThrow({ where: { userId: user } });
      const system = await db().walletAccount.findUniqueOrThrow({ where: { code: 'ADJUSTMENT' } });

      // One-sided journal: rejected at COMMIT.
      await expect(
        app.diContainer.resolve('runInTransaction')(async (tx) => {
          const j = await tx.walletJournal.create({
            data: {
              journalNo: `WJ-TEST-${randomUUID().slice(0, 8)}`,
              kind: 'ADJUSTMENT_CREDIT',
              category: 'ADJUSTMENTS',
              idempotencyKey: `it:${randomUUID()}`,
              userId: user,
              amountPaise: 1n,
              title: 'one-sided',
            },
          });
          await tx.walletPosting.create({
            data: { journalId: j.id, accountId: system.id, amountPaise: -1n },
          });
        }),
      ).rejects.toThrow(/unbalanced/);

      // A user posting whose balanceAfter does not follow the previous one: rejected at INSERT.
      await expect(
        db().walletPosting.create({
          data: {
            journalId: r.journal.id,
            accountId: account.id,
            amountPaise: 5n,
            balanceAfterPaise: 1_005n,
          },
        }),
      ).rejects.toThrow(/balance chain/);
      expect(await ledgerOf(app, user)).toMatchObject({ balance: 1_000n, unbalanced: 0 });
    });

    it('a user balance can never go negative', async () => {
      const user = customer();
      await post(app, { userId: user, amountPaise: 1_000n });
      await expect(
        db()
          .$executeRaw`UPDATE "wallet_accounts" SET "balancePaise" = -1 WHERE "userId" = ${user}::uuid`,
      ).rejects.toThrow();
    });
  });

  describe('GET /wallet', () => {
    it('returns the own balance, ₹0 for a new customer', async () => {
      const fresh = customer();
      const empty = await call(app, 'GET', '/wallet', { user: fresh });
      expect(empty.statusCode).toBe(200);
      expect(data(empty)).toEqual({
        balancePaise: 0,
        balance: '0.00',
        currency: 'INR',
        status: 'ACTIVE',
        frozenReason: null,
        week: { creditsPaise: 0, credits: '0.00', changePercent: null },
      });

      const user = customer();
      await post(app, { userId: user, amountPaise: 12_489_265n });
      const res = await call(app, 'GET', '/wallet', { user });
      expect(data(res)).toMatchObject({ balancePaise: 12_489_265, balance: '124892.65' });
    });

    it('401 without a token, 403 for staff', async () => {
      expect((await call(app, 'GET', '/wallet')).statusCode).toBe(401);
      expect((await call(app, 'GET', '/wallet', { user: staff() })).statusCode).toBe(403);
    });
  });
});
