import { randomBytes } from 'node:crypto';

import { ConflictError, InternalError, NotFoundError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { WALLET_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { emitWalletEvent } from '../../adapters/events.js';
import { uuidv7 } from '../../adapters/uuid.js';
import {
  type AccountRow,
  type AccountStatus,
  type BalanceView,
  type Direction,
  type JournalFilter,
  type JournalRow,
  type Mismatch,
  type PostInput,
  type PostResult,
  type SystemAccountCode,
  type TransactionView,
  type WalletCategory,
  toBalanceView,
  toTransactionView,
} from './ledger.types.js';

type Deps = Pick<Cradle, 'ledgerRepository'>;

const yymmdd = (d = new Date()) => d.toISOString().slice(2, 10).replaceAll('-', '');
/** WJ-yymmdd-XXXXXXXX (4 random bytes; a collision only retries the insert). */
export const newJournalNo = () => `WJ-${yymmdd()}-${randomBytes(4).toString('hex').toUpperCase()}`;

const MAX_AMOUNT_PAISE = 10_000_000_000n; // ₹10 crore: far above any business limit, guards typos

/**
 * The double-entry wallet ledger (D-54). `post` is the ONLY way money moves:
 *   1. claim the idempotency key (INSERT … ON CONFLICT DO NOTHING on the journal)
 *   2. one conditional UPDATE of the customer's balance (row lock; debit refused when short/frozen)
 *   3. two postings (customer ±, system ∓) — the DB checks the chain and the zero sum at commit
 *   4. outbox event, in the same transaction
 * It must run inside the caller's transaction, so the business row that caused it commits with it.
 */
export class LedgerService {
  private system: Map<SystemAccountCode, string> | undefined;

  constructor(private readonly deps: Deps) {}

  async post(tx: Tx, input: PostInput): Promise<PostResult> {
    if (input.amountPaise <= 0n || input.amountPaise > MAX_AMOUNT_PAISE)
      throw new InternalError(`ledger: invalid amount ${input.amountPaise.toString()}`);
    const repo = this.deps.ledgerRepository;
    const counterpartyId = await this.systemAccount(tx, input.counterparty);

    const replay = await repo.journalByKey(tx, input.idempotencyKey);
    if (replay !== null) return this.replayOf(tx, replay, input);

    await repo.ensureAccount(tx, input.userId);
    let journal: JournalRow | null = null;
    for (let attempt = 0; journal === null && attempt < 3; attempt += 1) {
      journal = await repo.insertJournal(tx, {
        id: uuidv7(),
        journalNo: newJournalNo(),
        kind: input.kind,
        category: input.category,
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
        amountPaise: input.amountPaise,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        title: input.title,
        subtitle: input.subtitle ?? null,
        ...(input.metadata == null ? {} : { metadata: input.metadata as object }),
        reversalOf: input.reversalOf ?? null,
        createdBy: input.createdBy ?? null,
      });
      if (journal === null) {
        // A concurrent writer committed the same key first: answer with its result.
        const winner = await repo.journalByKey(tx, input.idempotencyKey);
        if (winner !== null) return this.replayOf(tx, winner, input);
        // Otherwise the random journalNo collided: try another number.
      }
    }
    if (journal === null) throw new InternalError('ledger: could not allocate a journal number');

    const delta = input.direction === 'CREDIT' ? input.amountPaise : -input.amountPaise;
    const account = await repo.applyDelta(tx, input.userId, delta);
    if (account === null) {
      // Rolls back the journal too (the whole caller transaction fails).
      const current = await repo.accountOf(input.userId, tx);
      if (current?.status === 'FROZEN')
        throw new ConflictError('This wallet is frozen; contact support', {
          details: { reason: 'ACCOUNT_FROZEN' },
        });
      throw new ConflictError('Insufficient wallet balance', {
        details: {
          reason: 'INSUFFICIENT_BALANCE',
          availablePaise: Number(current?.balancePaise ?? 0n),
          requiredPaise: Number(input.amountPaise),
        },
      });
    }

    await repo.insertPostings(tx, [
      {
        id: uuidv7(),
        journalId: journal.id,
        accountId: account.id,
        amountPaise: delta,
        balanceAfterPaise: account.balancePaise,
      },
      { id: uuidv7(), journalId: journal.id, accountId: counterpartyId, amountPaise: -delta },
    ]);

    await emitWalletEvent(
      tx,
      WALLET_EVENTS.transactionPosted,
      {
        journalId: journal.id,
        journalNo: journal.journalNo,
        userId: journal.userId,
        kind: journal.kind,
        category: journal.category,
        direction: input.direction,
        amountPaise: Number(journal.amountPaise),
        balanceAfterPaise: Number(account.balancePaise),
        refType: journal.refType,
        refId: journal.refId,
      },
      input.correlationId ?? journal.id,
    );

    return {
      journal,
      direction: input.direction,
      balanceAfterPaise: account.balancePaise,
      replayed: false,
    };
  }

  /** Balance + last-7-days figures, straight from the ledger (never a cache). */
  async balanceOf(userId: string): Promise<BalanceView> {
    const account = await this.deps.ledgerRepository.accountOf(userId);
    if (account === null) return toBalanceView(null);
    const week = await this.deps.ledgerRepository.weekly(
      account.id,
      new Date(Date.now() - 7 * 24 * 3_600_000),
    );
    return toBalanceView(account, week);
  }

  // ── History (Wallet Statement / Transaction History) ──

  /** Own journals, newest first, with the signed amount and the balance after each. */
  async transactions(
    userId: string,
    q: Omit<JournalFilter, 'userId'>,
  ): Promise<Paginated<TransactionView>> {
    const repo = this.deps.ledgerRepository;
    const page = await repo.journals({ ...q, userId });
    const account = await repo.accountOf(userId);
    const postings =
      account === null
        ? new Map<string, { amountPaise: bigint; balanceAfterPaise: bigint | null }>()
        : await repo.userPostings(
            account.id,
            page.items.map((j) => j.id),
          );
    return { ...page, items: page.items.map((j) => toTransactionView(j, postings.get(j.id))) };
  }

  /** One own journal (any other id → 404, existence is never revealed). */
  async transaction(userId: string, id: string): Promise<TransactionView> {
    const repo = this.deps.ledgerRepository;
    const j = await repo.journal(id);
    if (j?.userId !== userId) throw new NotFoundError('Transaction');
    const account = await repo.accountOf(userId);
    const postings =
      account === null
        ? new Map<string, { amountPaise: bigint; balanceAfterPaise: bigint | null }>()
        : await repo.userPostings(account.id, [j.id]);
    return toTransactionView(j, postings.get(j.id));
  }

  /** Filter-chip counts ("All Entries (24)", "Refunds", …) for the same date range. */
  async transactionCounts(userId: string, range: { from?: Date; to?: Date }) {
    const counts = await this.deps.ledgerRepository.categoryCounts({ userId, ...range });
    const byCategory: Record<WalletCategory, number> = {
      TOPUPS: counts.get('TOPUPS') ?? 0,
      PURCHASES: counts.get('PURCHASES') ?? 0,
      REFUNDS: counts.get('REFUNDS') ?? 0,
      REWARDS: counts.get('REWARDS') ?? 0,
      ADJUSTMENTS: counts.get('ADJUSTMENTS') ?? 0,
    };
    return { all: Object.values(byCategory).reduce((a, b) => a + b, 0), byCategory };
  }

  /** Statement data, oldest first: opening balance, rows, closing balance (max `limit` rows). */
  async statement(userId: string, from: Date, to: Date, limit: number) {
    const repo = this.deps.ledgerRepository;
    const account = await repo.accountOf(userId);
    if (account === null)
      return { opening: 0n, closing: 0n, rows: [] as TransactionView[], truncated: false };
    const journals = await repo.journalsBetween(userId, from, to, limit + 1);
    const truncated = journals.length > limit;
    const kept = journals.slice(0, limit);
    const postings = await repo.userPostings(
      account.id,
      kept.map((j) => j.id),
    );
    return {
      opening: await repo.balanceAt(account.id, from),
      closing: await repo.balanceAt(account.id, to),
      rows: kept.map((j) => toTransactionView(j, postings.get(j.id))),
      truncated,
    };
  }

  // ── Staff console ──

  async accounts(f: { status?: AccountStatus; userId?: string; cursor?: string; limit: number }) {
    const page = await this.deps.ledgerRepository.accounts(f);
    return {
      ...page,
      items: page.items.map((a) => ({
        userId: a.userId,
        ...toBalanceView(a),
        updatedAt: a.updatedAt,
      })),
    };
  }

  /** Journals of any customers (filters), with each customer-side amount. */
  async journals(f: JournalFilter): Promise<Paginated<TransactionView & { userId: string }>> {
    const page = await this.deps.ledgerRepository.journals(f);
    const postings = await this.deps.ledgerRepository.userSidePostings(page.items.map((j) => j.id));
    return {
      ...page,
      items: page.items.map((j) => ({
        userId: j.userId,
        ...toTransactionView(j, postings.get(j.id)),
      })),
    };
  }

  /** Freeze (debits refused, credits still land) / unfreeze, in the caller's transaction. */
  setStatusInTx(
    tx: Tx,
    userId: string,
    status: AccountStatus,
    reason: string | null,
  ): Promise<AccountRow> {
    return this.deps.ledgerRepository.setStatus(tx, userId, status, reason);
  }

  accountInTx(tx: Tx, userId: string): Promise<AccountRow | null> {
    return this.deps.ledgerRepository.accountOf(userId, tx);
  }

  /** Reconciliation findings (ledger-check job). */
  mismatches(): Promise<Mismatch[]> {
    return this.deps.ledgerRepository.mismatches();
  }

  /** The journal posted under an idempotency key (e.g. pay:<paymentId>), or null. */
  journalByKey(key: string, tx?: Tx): Promise<JournalRow | null> {
    return this.deps.ledgerRepository.journalByKey(tx, key);
  }

  /** Total refunded to the wallet for one wallet-paid payment (caller holds the payment lock). */
  refundedForPaymentInTx(tx: Tx, paymentId: string): Promise<bigint> {
    return this.deps.ledgerRepository.sumByRef(tx, 'REFUND_CREDIT', 'PAYMENT', paymentId);
  }

  /** Current balance inside the caller's transaction (top-up limit checks). */
  async balanceInTx(tx: Tx, userId: string): Promise<bigint> {
    return (await this.deps.ledgerRepository.accountOf(userId, tx))?.balancePaise ?? 0n;
  }

  /** Same key again: the same movement is returned; a DIFFERENT movement under it is refused. */
  private async replayOf(tx: Tx, journal: JournalRow, input: PostInput): Promise<PostResult> {
    const same =
      journal.userId === input.userId &&
      journal.kind === input.kind &&
      journal.amountPaise === input.amountPaise;
    const account = await this.deps.ledgerRepository.accountOf(input.userId, tx);
    const posting =
      same && account !== null
        ? await this.deps.ledgerRepository.userPostingOf(tx, journal.id, account.id)
        : null;
    const direction: Direction | null =
      posting === null ? null : posting.amountPaise > 0n ? 'CREDIT' : 'DEBIT';
    if (!same || posting === null || direction !== input.direction)
      throw new ConflictError('This request key was already used for a different movement', {
        details: { reason: 'IDEMPOTENCY_KEY_REUSED', journalNo: journal.journalNo },
      });
    return {
      journal,
      direction,
      balanceAfterPaise: posting.balanceAfterPaise ?? 0n,
      replayed: true,
    };
  }

  private async systemAccount(tx: Tx, code: SystemAccountCode): Promise<string> {
    this.system ??= await this.deps.ledgerRepository.systemAccounts(tx);
    const id = this.system.get(code);
    if (id === undefined) throw new InternalError(`ledger: system account ${code} is missing`);
    return id;
  }
}
