import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import type { EventEnvelope, PaymentCapturedV1, RefundProcessedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { fromPaise } from '../pricing/index.js';
import type { LedgerRow } from './transactions.repository.js';
import type {
  LedgerCheckView,
  LedgerEntryView,
  OrderLedgerView,
  PaymentTotals,
} from './transactions.types.js';

type Deps = Pick<Cradle, 'transactionsRepository' | 'paymentClient' | 'logger'>;

/** Ledger rows must settle this long before a check (events still in flight are not flagged). */
const SETTLE_MS = 10 * 60_000;
const CHECK_BATCH = 200;

/**
 * The order money ledger. Rows are written by the payment-event handlers INSIDE the inbox
 * transaction (one statement, idempotent by key), so a ledger row exists exactly when the event
 * was processed. Totals are SUMs, never a stored balance: events may arrive in any order.
 */
export class TransactionsService {
  constructor(private readonly deps: Deps) {}

  /** payment.captured.v1 → CAPTURE (also captures on closed orders: the money arrived). */
  recordCapture(tx: Tx, e: EventEnvelope): Promise<boolean> {
    const d = e.data as PaymentCapturedV1;
    return this.deps.transactionsRepository.insert(tx, {
      orderId: d.orderId,
      kind: 'CAPTURE',
      amountPaise: d.amountPaise,
      currency: d.currency,
      method: normalizeMethod(d.method),
      paymentId: d.paymentId,
      refundId: null,
      providerRef: d.providerPaymentId.slice(0, 64),
      sourceRef: null,
      idempotencyKey: `capture:${d.paymentId}`,
      sourceEventId: e.id,
      occurredAt: new Date(e.occurredAt),
    });
  }

  /** payment.refund_processed.v1 → REFUND (one row per partial refund; re-sends dedupe). */
  async recordRefund(tx: Tx, e: EventEnvelope): Promise<boolean> {
    const d = e.data as RefundProcessedV1;
    const repo = this.deps.transactionsRepository;
    return repo.insert(tx, {
      orderId: d.orderId,
      kind: 'REFUND',
      amountPaise: d.amountPaise,
      currency: 'INR',
      method: await repo.captureMethod(tx, d.paymentId),
      paymentId: d.paymentId,
      refundId: d.refundId,
      providerRef: d.arn?.slice(0, 64) ?? null,
      sourceRef: d.sourceRef,
      idempotencyKey: `refund:${d.refundId}`,
      sourceEventId: e.id,
      occurredAt: new Date(e.occurredAt),
    });
  }

  paymentMethod(tx: Tx, orderId: string): Promise<string | null> {
    return this.deps.transactionsRepository.orderPaymentMethod(tx, orderId);
  }

  async forOrder(orderId: string): Promise<OrderLedgerView> {
    const repo = this.deps.transactionsRepository;
    const [rows, totals] = await Promise.all([repo.forOrder(orderId), repo.sums({ orderId })]);
    return { orderId, summary: summary(totals), transactions: rows.map(toView) };
  }

  /**
   * Reconcile job: per payment with new ledger rows (settled) or an open mismatch, compare the
   * ledger sums with payment-service's own totals. Never corrects anything; mismatches are
   * listed for finance. Per-payment failures (service down) are skipped and retried next run.
   */
  async reconcile(settleMs = SETTLE_MS): Promise<{ checked: number; mismatches: number }> {
    const { transactionsRepository: repo, paymentClient, logger } = this.deps;
    let checked = 0;
    let mismatches = 0;
    for (const { paymentId, orderId } of await repo.dueForCheck(settleMs, CHECK_BATCH)) {
      let payment: PaymentTotals;
      try {
        payment = await paymentClient.totals(paymentId);
      } catch (err) {
        logger.warn({ err, paymentId }, 'ledger reconcile: payment lookup failed; retrying later');
        continue;
      }
      const ledger = await repo.sums({ paymentId });
      const ok =
        ledger.capturedPaise === payment.capturedPaise &&
        ledger.refundedPaise === payment.refundedPaise;
      await repo.saveCheck({
        paymentId,
        orderId,
        status: ok ? 'OK' : 'MISMATCH',
        ledgerCapturedPaise: ledger.capturedPaise,
        ledgerRefundedPaise: ledger.refundedPaise,
        paymentCapturedPaise: payment.capturedPaise,
        paymentRefundedPaise: payment.refundedPaise,
      });
      checked += 1;
      if (!ok) {
        mismatches += 1;
        logger.error({ paymentId, orderId, ledger, payment }, 'order ledger mismatch');
      }
    }
    return { checked, mismatches };
  }

  async mismatches(query: { cursor?: string; limit: number }): Promise<Paginated<LedgerCheckView>> {
    const rows = await this.deps.transactionsRepository.mismatches(query.cursor, query.limit);
    const items = rows.slice(0, query.limit);
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.paymentId ?? null) : null,
      limit: query.limit,
    };
  }
}

/** Gateway method names, lower-case, bounded (no instrument data ever reaches here). */
const normalizeMethod = (method: string | null): string | null =>
  method === null ? null : method.trim().toLowerCase().slice(0, 20) || null;

const summary = (t: PaymentTotals) => ({
  capturedPaise: t.capturedPaise,
  refundedPaise: t.refundedPaise,
  netPaise: t.capturedPaise - t.refundedPaise,
  captured: fromPaise(t.capturedPaise),
  refunded: fromPaise(t.refundedPaise),
  net: fromPaise(t.capturedPaise - t.refundedPaise),
});

const toView = (r: LedgerRow): LedgerEntryView => ({
  id: r.id,
  kind: r.kind,
  amountPaise: Number(r.amountPaise),
  amount: fromPaise(Number(r.amountPaise)),
  currency: r.currency,
  method: r.method,
  paymentId: r.paymentId,
  refundId: r.refundId,
  providerRef: r.providerRef,
  sourceRef: r.sourceRef,
  occurredAt: r.occurredAt,
  recordedAt: r.recordedAt,
});
