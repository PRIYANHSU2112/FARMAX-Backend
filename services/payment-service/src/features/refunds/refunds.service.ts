import { ConflictError, ForbiddenError, NotFoundError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { type OrderRefundRequestedV1, PAYMENT_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { emitPaymentEvent } from '../../adapters/events.js';
import { GatewayError, type GatewayRefund } from '../../adapters/gateway.js';
import { WalletRefusal } from '../../adapters/wallet-client.js';
import type { Actor } from '../audit/index.js';
import { type PaymentRow, newNumber } from '../payments/index.js';
import {
  type DecisionInput,
  type RefundListQuery,
  type RefundRow,
  type RefundView,
  backoffAfter,
} from './refunds.types.js';

type Deps = Pick<
  Cradle,
  | 'refundsRepository'
  | 'runInTransaction'
  | 'paymentsService'
  | 'gateway'
  | 'walletClient'
  | 'settingsService'
  | 'auditService'
  | 'logger'
>;

const CLAIM_BATCH = 10;
const STALE_ACCEPTED_MS = 60 * 60_000;
const STALE_CLAIM_MS = 5 * 60_000;
const CAPTURED = new Set(['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

const rupees = (paise: bigint): string =>
  `${String(paise / 100n)}.${String(paise % 100n).padStart(2, '0')}`;

export const toRefundView = (r: RefundRow): RefundView => ({
  ...r,
  amountPaise: Number(r.amountPaise),
  amount: rupees(r.amountPaise),
});

/**
 * Refund EXECUTION (D-45). order-service decides (order.refund_requested.v1, unique sourceRef);
 * this feature guards the amount, waits for approval when needed, calls the gateway with backoff
 * and reports initiated → processed | failed. A gateway call never runs inside a DB transaction:
 * refunds are first claimed (PROCESSING), then sent, then the outcome is recorded.
 */
export class RefundsService {
  constructor(private readonly deps: Deps) {}

  // ── Decision in (order event) ──

  async requestInTx(tx: Tx, d: OrderRefundRequestedV1, correlationId: string): Promise<void> {
    const repo = this.deps.refundsRepository;
    const existing = await repo.bySourceRef(d.sourceRef, tx);
    if (existing !== null) return this.answerRepeat(tx, existing, correlationId);

    const p = await this.deps.paymentsService.lockInTx(tx, d.paymentId);
    const base = {
      refundNo: newNumber('RF'),
      sourceRef: d.sourceRef,
      paymentId: d.paymentId,
      orderId: d.orderId,
      amountPaise: BigInt(d.amountPaise),
      reason: d.reason.slice(0, 300),
      isSystem: d.isSystem,
      requestedBy: d.requestedBy,
    };
    const refuse = async (why: string) => {
      const r = await repo.create(tx, {
        ...base,
        paymentId: p?.id ?? d.paymentId,
        orderId: p?.orderId ?? d.orderId,
        status: 'FAILED_FINAL',
        lastError: why,
        failedAt: new Date(),
      });
      await this.emitFailed(tx, r, why, correlationId);
    };
    if (p?.orderId !== d.orderId) return refuse('PAYMENT_NOT_FOUND_FOR_ORDER');
    if (!CAPTURED.has(p.status)) return refuse('PAYMENT_NOT_CAPTURED');
    const committed = await repo.committedPaise(tx, p.id);
    if (committed + BigInt(d.amountPaise) > p.capturedPaise) return refuse('EXCEEDS_CAPTURED');

    const { refundManualApprovalAbovePaise } = await this.deps.settingsService.current();
    const needsApproval = !d.isSystem && d.amountPaise > refundManualApprovalAbovePaise;
    await repo.create(tx, {
      ...base,
      status: needsApproval ? 'PENDING_APPROVAL' : 'APPROVED',
      nextRetryAt: needsApproval ? null : new Date(),
    });
  }

  /** Same sourceRef again: a retry of a failed refund, or a re-ask → answer with the state. */
  private async answerRepeat(tx: Tx, r: RefundRow, correlationId: string): Promise<void> {
    switch (r.status) {
      case 'FAILED_FINAL':
        await this.deps.refundsRepository.update(
          r.id,
          { status: 'RETRYING', attempts: 0, nextRetryAt: new Date(), lastError: null },
          tx,
        );
        return;
      case 'PROCESSED':
        return this.emitProcessed(tx, r, correlationId);
      case 'PROCESSING':
        if (r.providerRefundId !== null) return this.emitInitiated(tx, r, correlationId);
        return;
      default:
        return; // CREATED / PENDING_APPROVAL / APPROVED / RETRYING: still in progress
    }
  }

  // ── Admin ──

  /** Manual decisions above the threshold. Segregation of duties: approver ≠ requester. */
  async approve(actor: Actor, id: string, input: DecisionInput): Promise<RefundView> {
    return this.deps.runInTransaction(async (tx) => {
      const r = await this.locked(tx, id);
      if (r.status !== 'PENDING_APPROVAL')
        throw new ConflictError(`Refund is ${r.status}`, {
          details: { reason: 'NOT_PENDING_APPROVAL', status: r.status },
        });
      if (actor.userId === null || actor.userId === r.requestedBy)
        throw new ForbiddenError('A refund must be approved by someone other than its requester');
      const after = await this.deps.refundsRepository.update(
        id,
        {
          status: 'APPROVED',
          approvedBy: actor.userId,
          approvedAt: new Date(),
          nextRetryAt: new Date(),
        },
        tx,
      );
      await this.deps.auditService.record(tx, actor, {
        action: 'refund.approve',
        targetType: 'refund',
        targetId: id,
        before: { status: r.status },
        after: { status: after.status },
        reason: input.reason,
      });
      return toRefundView(after);
    });
  }

  /** FAILED_FINAL → RETRYING (same refund, same sourceRef: never a second refund). */
  async retry(actor: Actor, id: string, input: DecisionInput): Promise<RefundView> {
    return this.deps.runInTransaction(async (tx) => {
      const r = await this.locked(tx, id);
      if (r.status !== 'FAILED_FINAL')
        throw new ConflictError(`Refund is ${r.status}`, {
          details: { reason: 'NOT_FAILED', status: r.status },
        });
      const after = await this.deps.refundsRepository.update(
        id,
        { status: 'RETRYING', attempts: 0, nextRetryAt: new Date(), lastError: null },
        tx,
      );
      await this.deps.auditService.record(tx, actor, {
        action: 'refund.retry',
        targetType: 'refund',
        targetId: id,
        before: { status: r.status, lastError: r.lastError },
        after: { status: after.status },
        reason: input.reason,
      });
      return toRefundView(after);
    });
  }

  // ── Execution (BullMQ) ──

  /** Claim due refunds, call the gateway OUTSIDE any transaction, record each outcome. */
  async executeDue(): Promise<{ sent: number }> {
    const claimed = await this.deps.refundsRepository.claimDue(CLAIM_BATCH);
    for (const r of claimed) await this.send(r);
    return { sent: claimed.length };
  }

  private async send(r: RefundRow): Promise<void> {
    const p = await this.deps.paymentsService.get(r.paymentId);
    if (p.provider === 'WALLET') return this.sendToWallet(r, p);
    if (p.providerPaymentId === null)
      return this.recordError(r, new GatewayError('No captured gateway payment', false));
    try {
      // After a crash the gateway may already have this refund: adopt it, never send twice.
      const known = (await this.deps.gateway.listRefunds(p.providerPaymentId)).find(
        (g) => g.refundId === r.id,
      );
      const gr =
        known ??
        (await this.deps.gateway.refund({
          paymentId: p.providerPaymentId,
          amountPaise: Number(r.amountPaise),
          refundId: r.id,
          receipt: r.refundNo,
        }));
      await this.applyGatewayRefund(r.id, gr);
    } catch (err) {
      await this.recordError(r, err);
    }
  }

  /**
   * WALLET provider (D-54): the refund is a wallet credit (idempotent per refund id in
   * wallet-service, never above the wallet debit), processed at once. The journal number stands in
   * for the gateway refund id and the ARN.
   */
  private async sendToWallet(r: RefundRow, p: PaymentRow): Promise<void> {
    try {
      const c = await this.deps.walletClient.credit({
        refundId: r.id,
        paymentId: p.id,
        userId: p.userId,
        amountPaise: Number(r.amountPaise),
        reason: r.reason,
      });
      await this.applyGatewayRefund(r.id, {
        id: c.journalNo,
        paymentId: p.providerPaymentId ?? p.id,
        amountPaise: c.amountPaise,
        status: 'processed',
        arn: c.journalNo,
        refundId: r.id,
      });
    } catch (err) {
      await this.recordError(
        r,
        err instanceof WalletRefusal
          ? new GatewayError(err.message, false, err.reason)
          : new GatewayError(err instanceof Error ? err.message : String(err), true),
      );
    }
  }

  private async recordError(r: RefundRow, err: unknown): Promise<void> {
    const ge = err instanceof GatewayError ? err : new GatewayError(String(err), true);
    const { refundMaxAttempts } = await this.deps.settingsService.current();
    const final = !ge.retryable || r.attempts >= refundMaxAttempts;
    await this.deps.runInTransaction(async (tx) => {
      const locked = await this.locked(tx, r.id);
      if (locked.status !== 'PROCESSING' || locked.providerRefundId !== null) return;
      if (final) {
        const after = await this.deps.refundsRepository.update(
          r.id,
          { status: 'FAILED_FINAL', failedAt: new Date(), lastError: ge.message.slice(0, 300) },
          tx,
        );
        await this.emitFailed(tx, after, ge.message, `refund:${r.id}`);
      } else {
        await this.deps.refundsRepository.update(
          r.id,
          {
            status: 'RETRYING',
            nextRetryAt: new Date(Date.now() + backoffAfter(locked.attempts)),
            lastError: ge.message.slice(0, 300),
          },
          tx,
        );
      }
    });
    this.deps.logger.warn(
      { refundId: r.id, attempts: r.attempts, final, code: ge.code },
      'gateway refund failed',
    );
  }

  /** Gateway refund state (send result, webhook, poll) → our refund. Idempotent. */
  async applyGatewayRefund(refundId: string, gr: GatewayRefund): Promise<void> {
    const { refundExpectedDays } = await this.deps.settingsService.current();
    await this.deps.runInTransaction(async (tx) => {
      const r = await this.locked(tx, refundId);
      const ctx = `refund:${r.id}`;
      if (r.status === 'PROCESSED' || r.status === 'FAILED_FINAL') return;
      if (r.providerRefundId === null) {
        const current = await this.deps.refundsRepository.update(
          r.id,
          {
            status: 'PROCESSING',
            providerRefundId: gr.id,
            initiatedAt: new Date(),
            expectedBy: new Date(Date.now() + refundExpectedDays * 86_400_000),
          },
          tx,
        );
        await this.emitInitiated(tx, current, ctx);
      }
      if (gr.status === 'processed') {
        const p = await this.deps.paymentsService.lockInTx(tx, r.paymentId);
        if (p === null) throw new NotFoundError('Payment');
        const totals = await this.deps.paymentsService.recordRefundedInTx(tx, p, r.amountPaise);
        const done = await this.deps.refundsRepository.update(
          r.id,
          { status: 'PROCESSED', processedAt: new Date(), arn: gr.arn },
          tx,
        );
        await this.emitProcessed(tx, done, ctx, totals);
      } else if (gr.status === 'failed') {
        const failed = await this.deps.refundsRepository.update(
          r.id,
          {
            status: 'FAILED_FINAL',
            failedAt: new Date(),
            lastError: 'Gateway reported the refund failed',
          },
          tx,
        );
        await this.emitFailed(tx, failed, 'Gateway reported the refund failed', ctx);
      }
    });
  }

  /** Webhook `refund.processed` / `refund.failed`. */
  async onGatewayRefund(gr: GatewayRefund): Promise<boolean> {
    const r =
      (await this.deps.refundsRepository.byProviderRefundId(gr.id)) ??
      (gr.refundId === null ? null : await this.deps.refundsRepository.find(gr.refundId));
    if (r === null) return false;
    await this.applyGatewayRefund(r.id, gr);
    return true;
  }

  /** Lost-webhook guard + crash recovery for PROCESSING refunds. */
  async syncStale(): Promise<{ checked: number }> {
    const now = Date.now();
    const stale = await this.deps.refundsRepository.stale(
      new Date(now - STALE_ACCEPTED_MS),
      new Date(now - STALE_CLAIM_MS),
      50,
    );
    for (const r of stale) {
      if (r.providerRefundId === null) {
        // Claimed but the worker died before the outcome: back to RETRYING (send adopts any
        // refund the gateway already has, by our refund id).
        await this.deps.refundsRepository.update(r.id, {
          status: 'RETRYING',
          nextRetryAt: new Date(),
        });
        continue;
      }
      try {
        const p = await this.deps.paymentsService.get(r.paymentId);
        // Wallet refunds settle in one transaction; nothing to fetch from a gateway.
        if (p.providerPaymentId !== null && p.provider !== 'WALLET')
          await this.applyGatewayRefund(
            r.id,
            await this.deps.gateway.fetchRefund(p.providerPaymentId, r.providerRefundId),
          );
      } catch (err) {
        this.deps.logger.warn({ err, refundId: r.id }, 'refund status check failed');
      }
    }
    return { checked: stale.length };
  }

  // ── Reads ──

  async get(id: string): Promise<RefundView> {
    const r = await this.deps.refundsRepository.find(id);
    if (r === null) throw new NotFoundError('Refund');
    return toRefundView(r);
  }

  async list(query: RefundListQuery): Promise<Paginated<RefundView>> {
    const page = await this.deps.refundsRepository.list(query);
    return { ...page, items: page.items.map(toRefundView) };
  }

  async forPayment(paymentId: string): Promise<RefundView[]> {
    return (await this.deps.refundsRepository.forPayment(paymentId)).map(toRefundView);
  }

  // ── Helpers ──

  private async locked(tx: Tx, id: string): Promise<RefundRow> {
    const r = await this.deps.refundsRepository.lock(tx, id);
    if (r === null) throw new NotFoundError('Refund');
    return r;
  }

  private emitInitiated(tx: Tx, r: RefundRow, ctx: string): Promise<void> {
    return emitPaymentEvent(
      tx,
      PAYMENT_EVENTS.refundInitiated,
      {
        refundId: r.id,
        sourceRef: r.sourceRef,
        paymentId: r.paymentId,
        orderId: r.orderId,
        amountPaise: Number(r.amountPaise),
        providerRefundId: r.providerRefundId ?? '',
        expectedBy: (r.expectedBy ?? new Date()).toISOString(),
      },
      ctx,
    );
  }

  private async emitProcessed(
    tx: Tx,
    r: RefundRow,
    ctx: string,
    totals?: { refundedPaise: bigint; capturedPaise: bigint },
  ): Promise<void> {
    const t = totals ?? (await this.deps.paymentsService.get(r.paymentId));
    await emitPaymentEvent(
      tx,
      PAYMENT_EVENTS.refundProcessed,
      {
        refundId: r.id,
        sourceRef: r.sourceRef,
        paymentId: r.paymentId,
        orderId: r.orderId,
        amountPaise: Number(r.amountPaise),
        arn: r.arn,
        refundedPaise: Number(t.refundedPaise),
        capturedPaise: Number(t.capturedPaise),
      },
      ctx,
    );
  }

  private emitFailed(tx: Tx, r: RefundRow, reason: string, ctx: string): Promise<void> {
    return emitPaymentEvent(
      tx,
      PAYMENT_EVENTS.refundFailed,
      {
        refundId: r.id,
        sourceRef: r.sourceRef,
        paymentId: r.paymentId,
        orderId: r.orderId,
        amountPaise: Number(r.amountPaise),
        reason: reason.slice(0, 300),
      },
      ctx,
    );
  }
}
