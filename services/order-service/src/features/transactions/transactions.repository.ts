import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type {
  LedgerCheckView,
  NewLedgerEntry,
  PaymentTotals,
  TransactionKind,
} from './transactions.types.js';

export interface LedgerRow extends Omit<
  NewLedgerEntry,
  'amountPaise' | 'idempotencyKey' | 'sourceEventId'
> {
  id: string;
  amountPaise: bigint;
  recordedAt: Date;
}

const rowSelect = {
  id: true,
  orderId: true,
  kind: true,
  amountPaise: true,
  currency: true,
  method: true,
  paymentId: true,
  refundId: true,
  providerRef: true,
  sourceRef: true,
  occurredAt: true,
  recordedAt: true,
} as const;

/** Only place that touches `order_transactions` and `order_ledger_checks`. */
export class TransactionsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** INSERT … ON CONFLICT (idempotencyKey) DO NOTHING. False = already recorded. */
  async insert(tx: Tx, entry: NewLedgerEntry): Promise<boolean> {
    const { count } = await withPrismaErrors(() =>
      tx.orderTransaction.createMany({
        data: [{ ...entry, amountPaise: BigInt(entry.amountPaise) }],
        skipDuplicates: true,
      }),
    );
    return count === 1;
  }

  /** Method of the capture a refund goes back to (refund rows carry it for reporting). */
  async captureMethod(tx: Tx, paymentId: string): Promise<string | null> {
    const row = await tx.orderTransaction.findFirst({
      where: { paymentId, kind: 'CAPTURE' },
      select: { method: true },
    });
    return row?.method ?? null;
  }

  /** Gateway method of the order's first capture (printed on invoices). */
  async orderPaymentMethod(tx: Tx, orderId: string): Promise<string | null> {
    const row = await tx.orderTransaction.findFirst({
      where: { orderId, kind: 'CAPTURE' },
      select: { method: true },
      orderBy: { occurredAt: 'asc' },
    });
    return row?.method ?? null;
  }

  async forOrder(orderId: string): Promise<LedgerRow[]> {
    return withPrismaErrors(() =>
      this.db.orderTransaction.findMany({
        where: { orderId },
        select: rowSelect,
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: 500,
      }),
    );
  }

  /** Σ per kind for an order or a payment (index-backed). */
  async sums(where: { orderId: string } | { paymentId: string }): Promise<PaymentTotals> {
    const rows = await withPrismaErrors(() =>
      this.db.orderTransaction.groupBy({ by: ['kind'], where, _sum: { amountPaise: true } }),
    );
    const of = (kind: TransactionKind) =>
      Number(rows.find((r) => r.kind === kind)?._sum.amountPaise ?? 0n);
    return { capturedPaise: of('CAPTURE'), refundedPaise: of('REFUND') };
  }

  /**
   * Payments to (re)check: new ledger rows since the last check (settled for `settleMs`, so
   * in-flight events are not flagged), and every payment still in MISMATCH.
   */
  async dueForCheck(
    settleMs: number,
    limit: number,
  ): Promise<{ paymentId: string; orderId: string }[]> {
    return withPrismaErrors(
      () => this.db.$queryRaw<{ paymentId: string; orderId: string }[]>`
        SELECT t."paymentId", t."orderId"
        FROM "order_transactions" t
        LEFT JOIN "order_ledger_checks" c ON c."paymentId" = t."paymentId"
        WHERE t."recordedAt" < ${new Date(Date.now() - settleMs)}
        GROUP BY t."paymentId", t."orderId", c."checkedAt", c."status"
        HAVING c."checkedAt" IS NULL OR max(t."recordedAt") > c."checkedAt" OR c."status" = 'MISMATCH'
        ORDER BY max(t."recordedAt") DESC
        LIMIT ${limit}`,
    );
  }

  async saveCheck(check: Omit<LedgerCheckView, 'checkedAt'>): Promise<void> {
    const data = {
      orderId: check.orderId,
      status: check.status,
      ledgerCapturedPaise: BigInt(check.ledgerCapturedPaise),
      ledgerRefundedPaise: BigInt(check.ledgerRefundedPaise),
      paymentCapturedPaise: BigInt(check.paymentCapturedPaise),
      paymentRefundedPaise: BigInt(check.paymentRefundedPaise),
      checkedAt: new Date(),
    };
    await withPrismaErrors(() =>
      this.db.orderLedgerCheck.upsert({
        where: { paymentId: check.paymentId },
        create: { paymentId: check.paymentId, ...data },
        update: data,
      }),
    );
  }

  /** MISMATCH checks, newest first (keyset on checkedAt + paymentId). */
  async mismatches(cursor: string | undefined, limit: number): Promise<LedgerCheckView[]> {
    const rows = await withPrismaErrors(() =>
      this.db.orderLedgerCheck.findMany({
        where: { status: 'MISMATCH' },
        orderBy: [{ checkedAt: 'desc' }, { paymentId: 'desc' }],
        take: limit + 1,
        ...(cursor === undefined ? {} : { skip: 1, cursor: { paymentId: cursor } }),
      }),
    );
    return rows.map((r) => ({
      paymentId: r.paymentId,
      orderId: r.orderId,
      status: r.status,
      ledgerCapturedPaise: Number(r.ledgerCapturedPaise),
      ledgerRefundedPaise: Number(r.ledgerRefundedPaise),
      paymentCapturedPaise: Number(r.paymentCapturedPaise),
      paymentRefundedPaise: Number(r.paymentRefundedPaise),
      checkedAt: r.checkedAt,
    }));
  }
}
