import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  AccountRow,
  AccountStatus,
  JournalFilter,
  JournalRow,
  Mismatch,
  SystemAccountCode,
  WalletCategory,
} from './ledger.types.js';

/**
 * Only place that touches `wallet_accounts`, `wallet_journals` and `wallet_postings`.
 * Journals / postings are INSERT-only (DB triggers); a USER balance changes only through
 * `applyDelta` (one conditional UPDATE under the row lock) followed by its posting.
 */
export class LedgerRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async systemAccounts(tx?: Tx): Promise<Map<SystemAccountCode, string>> {
    const rows = await withPrismaErrors(() =>
      (tx ?? this.db).walletAccount.findMany({
        where: { ownerType: 'SYSTEM' },
        select: { id: true, code: true },
      }),
    );
    return new Map(rows.map((r) => [r.code as SystemAccountCode, r.id]));
  }

  async accountOf(userId: string, tx?: Tx): Promise<AccountRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).walletAccount.findUnique({
        where: { userId },
        select: {
          id: true,
          userId: true,
          balancePaise: true,
          status: true,
          frozenReason: true,
          frozenAt: true,
          currency: true,
        },
      }),
    );
  }

  /** Credits since `since` and the balance just before it (last posting before `since`). */
  async weekly(
    accountId: string,
    since: Date,
  ): Promise<{ creditsPaise: bigint; balanceBeforePaise: bigint }> {
    const rows = await withPrismaErrors(
      () =>
        this.db.$queryRaw<{ credits: bigint | null; before: bigint | null }[]>`
        SELECT
          (SELECT SUM("amountPaise") FROM "wallet_postings"
            WHERE "accountId" = ${accountId}::uuid AND "amountPaise" > 0
              AND "createdAt" >= ${since})::bigint AS "credits",
          (SELECT "balanceAfterPaise" FROM "wallet_postings"
            WHERE "accountId" = ${accountId}::uuid AND "createdAt" < ${since}
            ORDER BY "seq" DESC LIMIT 1) AS "before"`,
    );
    return { creditsPaise: rows[0]?.credits ?? 0n, balanceBeforePaise: rows[0]?.before ?? 0n };
  }

  /** Creates the customer's account if missing (concurrent creators: one wins, no error). */
  async ensureAccount(tx: Tx, userId: string): Promise<void> {
    await tx.walletAccount.createMany({
      data: [{ ownerType: 'USER', userId }],
      skipDuplicates: true,
    });
  }

  async journalByKey(tx: Tx | undefined, idempotencyKey: string): Promise<JournalRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).walletJournal.findUnique({ where: { idempotencyKey } }),
    );
  }

  /** Sum of journals of one kind that reference one object (e.g. refunds of one payment). */
  async sumByRef(
    tx: Tx,
    kind: JournalRow['kind'],
    refType: string,
    refId: string,
  ): Promise<bigint> {
    const agg = await tx.walletJournal.aggregate({
      where: { kind, refType, refId },
      _sum: { amountPaise: true },
    });
    return agg._sum.amountPaise ?? 0n;
  }

  /**
   * INSERT … ON CONFLICT DO NOTHING. A concurrent writer of the same key blocks here until it
   * commits; then this returns null (and the transaction stays usable to read the winner).
   */
  async insertJournal(
    tx: Tx,
    data: Prisma.WalletJournalCreateManyInput,
  ): Promise<JournalRow | null> {
    const [row] = await tx.walletJournal.createManyAndReturn({
      data: [data],
      skipDuplicates: true,
    });
    return (row as JournalRow | undefined) ?? null;
  }

  /**
   * The ONLY balance write. Credits always land; a debit lands only on an ACTIVE account that
   * stays ≥ 0. Row lock held until commit. null = refused (caller reads why).
   */
  async applyDelta(
    tx: Tx,
    userId: string,
    delta: bigint,
  ): Promise<{ id: string; balancePaise: bigint } | null> {
    const rows = await tx.$queryRaw<{ id: string; balancePaise: bigint }[]>`
      UPDATE "wallet_accounts"
         SET "balancePaise" = "balancePaise" + ${delta}::bigint,
             "version" = "version" + 1,
             "updatedAt" = now()
       WHERE "userId" = ${userId}::uuid
         AND "ownerType" = 'USER'
         AND (${delta}::bigint >= 0
              OR ("status" = 'ACTIVE' AND "balancePaise" + ${delta}::bigint >= 0))
      RETURNING "id", "balancePaise"`;
    return rows[0] ?? null;
  }

  async insertPostings(tx: Tx, rows: Prisma.WalletPostingCreateManyInput[]): Promise<void> {
    // One row at a time, in order: the chain trigger reads the previous posting of the account.
    for (const data of rows) await tx.walletPosting.create({ data, select: { id: true } });
  }

  async userPostingOf(
    tx: Tx,
    journalId: string,
    accountId: string,
  ): Promise<{ amountPaise: bigint; balanceAfterPaise: bigint | null } | null> {
    return tx.walletPosting.findFirst({
      where: { journalId, accountId },
      select: { amountPaise: true, balanceAfterPaise: true },
    });
  }

  // ── Reads (history, statement, console) ──

  async journals(f: JournalFilter): Promise<Paginated<JournalRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.walletJournal.findMany({
        where: this.where(f),
        orderBy: { id: 'desc' },
        ...cursorArgs(f),
      }),
    );
    return toPage(rows, f.limit);
  }

  journal(id: string): Promise<JournalRow | null> {
    return withPrismaErrors(() => this.db.walletJournal.findUnique({ where: { id } }));
  }

  /** The customer's side of these journals: signed amount + balance after. */
  async userPostings(
    accountId: string,
    journalIds: string[],
  ): Promise<Map<string, { amountPaise: bigint; balanceAfterPaise: bigint | null }>> {
    if (journalIds.length === 0) return new Map();
    const rows = await withPrismaErrors(() =>
      this.db.walletPosting.findMany({
        where: { accountId, journalId: { in: journalIds } },
        select: { journalId: true, amountPaise: true, balanceAfterPaise: true },
      }),
    );
    return new Map(rows.map((r) => [r.journalId, r]));
  }

  /** The customer side (USER account posting) of journals of any customers (staff lists). */
  async userSidePostings(
    journalIds: string[],
  ): Promise<Map<string, { amountPaise: bigint; balanceAfterPaise: bigint | null }>> {
    if (journalIds.length === 0) return new Map();
    const rows = await withPrismaErrors(() =>
      this.db.walletPosting.findMany({
        where: { journalId: { in: journalIds }, account: { ownerType: 'USER' } },
        select: { journalId: true, amountPaise: true, balanceAfterPaise: true },
      }),
    );
    return new Map(rows.map((r) => [r.journalId, r]));
  }

  async categoryCounts(f: Omit<JournalFilter, 'cursor' | 'limit' | 'category'>) {
    const rows = await withPrismaErrors(() =>
      this.db.walletJournal.groupBy({
        by: ['category'],
        where: this.where(f),
        _count: { _all: true },
      }),
    );
    return new Map<WalletCategory, number>(rows.map((r) => [r.category, r._count._all]));
  }

  /** Oldest first, at most `limit` (statement rows). */
  journalsBetween(userId: string, from: Date, to: Date, limit: number): Promise<JournalRow[]> {
    return withPrismaErrors(() =>
      this.db.walletJournal.findMany({
        where: { userId, createdAt: { gte: from, lt: to } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    );
  }

  /** Balance at `at` = balance after the account's last posting before it. */
  async balanceAt(accountId: string, at: Date): Promise<bigint> {
    const row = await withPrismaErrors(() =>
      this.db.walletPosting.findFirst({
        where: { accountId, createdAt: { lt: at } },
        orderBy: { seq: 'desc' },
        select: { balanceAfterPaise: true },
      }),
    );
    return row?.balanceAfterPaise ?? 0n;
  }

  async accounts(f: {
    status?: AccountStatus;
    userId?: string;
    cursor?: string;
    limit: number;
  }): Promise<Paginated<AccountRow & { updatedAt: Date }>> {
    const rows = await withPrismaErrors(() =>
      this.db.walletAccount.findMany({
        where: {
          ownerType: 'USER',
          ...(f.status === undefined ? {} : { status: f.status }),
          ...(f.userId === undefined ? {} : { userId: f.userId }),
        },
        select: {
          id: true,
          userId: true,
          balancePaise: true,
          status: true,
          frozenReason: true,
          frozenAt: true,
          currency: true,
          updatedAt: true,
        },
        orderBy: { id: 'desc' },
        ...cursorArgs(f),
      }),
    );
    return toPage(rows, f.limit);
  }

  /** Freeze / unfreeze (the account is created if missing, so a wallet can be frozen first). */
  async setStatus(
    tx: Tx,
    userId: string,
    status: AccountStatus,
    reason: string | null,
  ): Promise<AccountRow> {
    await this.ensureAccount(tx, userId);
    return tx.walletAccount.update({
      where: { userId },
      data: {
        status,
        frozenReason: status === 'FROZEN' ? reason : null,
        frozenAt: status === 'FROZEN' ? new Date() : null,
        version: { increment: 1 },
      },
      select: {
        id: true,
        userId: true,
        balancePaise: true,
        status: true,
        frozenReason: true,
        frozenAt: true,
        currency: true,
      },
    });
  }

  // ── Reconciliation (ledger-check job) ──

  /** USER balances that differ from SUM(postings); journals that do not sum to 0; global total. */
  async mismatches(): Promise<Mismatch[]> {
    const balances = await this.db.$queryRaw<{ userId: string; balance: bigint; sum: bigint }[]>`
      SELECT a."userId", a."balancePaise" AS "balance", COALESCE(SUM(p."amountPaise"), 0)::bigint AS "sum"
        FROM "wallet_accounts" a LEFT JOIN "wallet_postings" p ON p."accountId" = a."id"
       WHERE a."ownerType" = 'USER'
       GROUP BY a."id"
      HAVING a."balancePaise" <> COALESCE(SUM(p."amountPaise"), 0)`;
    const journals = await this.db.$queryRaw<{ journalId: string; sum: bigint }[]>`
      SELECT "journalId", SUM("amountPaise")::bigint AS "sum" FROM "wallet_postings"
       GROUP BY "journalId" HAVING SUM("amountPaise") <> 0`;
    const [total] = await this.db.$queryRaw<{ sum: bigint | null }[]>`
      SELECT SUM("amountPaise")::bigint AS "sum" FROM "wallet_postings"`;
    return [
      ...balances.map((b) => ({
        checkType: 'WALLET_BALANCE',
        refId: b.userId,
        userId: b.userId,
        expected: b.sum.toString(),
        actual: b.balance.toString(),
      })),
      ...journals.map((j) => ({
        checkType: 'WALLET_JOURNAL',
        refId: j.journalId,
        userId: null,
        expected: '0',
        actual: j.sum.toString(),
      })),
      ...((total?.sum ?? 0n) === 0n
        ? []
        : [
            {
              checkType: 'WALLET_TOTAL',
              refId: 'ALL',
              userId: null,
              expected: '0',
              actual: (total?.sum ?? 0n).toString(),
            },
          ]),
    ];
  }

  private where(f: Partial<JournalFilter>) {
    return {
      ...(f.userId === undefined ? {} : { userId: f.userId }),
      ...(f.category === undefined ? {} : { category: f.category }),
      ...(f.kind === undefined ? {} : { kind: f.kind }),
      ...(f.from === undefined && f.to === undefined
        ? {}
        : {
            createdAt: {
              ...(f.from === undefined ? {} : { gte: f.from }),
              ...(f.to === undefined ? {} : { lt: f.to }),
            },
          }),
    };
  }
}
