import { randomBytes } from 'node:crypto';

import {
  BadRequestError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@farmx/common/errors';
import type { AuthUser, Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { PAYMENT_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { emitPaymentEvent } from '../../adapters/events.js';
import { GatewayError, type GatewayPayment, maskVpa } from '../../adapters/gateway.js';
import { MockGateway } from '../../adapters/mock-gateway.js';
import { type WalletDebit, WalletRefusal } from '../../adapters/wallet-client.js';
import type { Actor } from '../audit/index.js';
import {
  type AttemptView,
  CAPTURED_STATUSES,
  type CheckoutView,
  type CreatePaymentInput,
  type CreateTopupPaymentInput,
  type MockPayInput,
  OPEN_STATUSES,
  type PaymentListQuery,
  type PaymentRow,
  type PaymentView,
  type VerifyInput,
  rupees,
  toPaymentView,
} from './payments.types.js';

type Deps = Pick<
  Cradle,
  | 'paymentsRepository'
  | 'runInTransaction'
  | 'gateway'
  | 'settingsService'
  | 'auditService'
  | 'webhooksService'
  | 'walletClient'
  | 'logger'
>;

const JOB_BATCH = 50;

const yymmdd = (d = new Date()) => d.toISOString().slice(2, 10).replaceAll('-', '');
export const newNumber = (prefix: string) =>
  `${prefix}-${yymmdd()}-${randomBytes(4).toString('hex').toUpperCase()}`;

const isOpen = (p: PaymentRow) => OPEN_STATUSES.includes(p.status);

/** The order of an ORDER payment (the DB CHECK guarantees both are set). */
const orderOf = (p: PaymentRow): { orderId: string; orderNo: string } => {
  if (p.orderId === null || p.orderNo === null)
    throw new Error(`payment ${p.id} (${p.purpose}) has no order`);
  return { orderId: p.orderId, orderNo: p.orderNo };
};

/** The top-up id of a WALLET_TOPUP payment (the DB CHECK guarantees it is set). */
const refOf = (p: PaymentRow): string => {
  if (p.referenceId === null) throw new Error(`payment ${p.id} (${p.purpose}) has no reference`);
  return p.referenceId;
};
const isCaptured = (p: PaymentRow) => CAPTURED_STATUSES.includes(p.status);

/** Wallet refusals that end the attempt (anything else is a bug or an outage). */
const WALLET_REFUSALS = new Set(['INSUFFICIENT_BALANCE', 'ACCOUNT_FROZEN']);

/** A wallet debit as a gateway capture (the journal number is the provider payment id). */
const walletCapture = (d: WalletDebit): GatewayPayment => ({
  id: d.journalNo ?? '',
  orderId: null,
  amountPaise: d.amountPaise,
  currency: 'INR',
  status: 'captured',
  method: 'wallet',
  vpa: null,
  cardLast4: null,
  cardNetwork: null,
  bank: null,
  wallet: 'farmx',
  errorCode: null,
  errorReason: null,
});

/** A refused wallet debit as a failed attempt (one id per attempt). */
const walletFailure = (p: PaymentRow, code: string, reason: string): GatewayPayment => ({
  ...walletCapture({
    status: 'NONE',
    paymentId: p.id,
    journalId: null,
    journalNo: `WF-${p.id}-${String(p.attemptCount + 1)}`,
    amountPaise: Number(p.amountPaise),
    refundedPaise: 0,
  }),
  status: 'failed',
  errorCode: code === 'INSUFFICIENT_BALANCE' ? 'INSUFFICIENT_WALLET_BALANCE' : 'WALLET_FROZEN',
  errorReason: reason,
});

/** Gateway failures surface as 503 (try again) or 502 (gateway refused); never as our 500. */
const gatewayFailure = (err: unknown): Error => {
  if (!(err instanceof GatewayError)) return err instanceof Error ? err : new Error(String(err));
  return err.retryable
    ? new ServiceUnavailableError('Payment gateway is unavailable; try again', { cause: err })
    : new ExternalServiceError('payment gateway', { cause: err, details: { code: err.code } });
};

/**
 * Payments (D-37): one payment per order, one gateway order, many attempts. The client never sends
 * an amount; outcomes are always re-read from the gateway (verify, webhook, reconcile all end in
 * `applyGatewayPayment`, under the payment row lock, so they never double-apply).
 */
export class PaymentsService {
  constructor(private readonly deps: Deps) {}

  // ── Create / reuse (internal: order-service checkout and "pay again") ──

  async createForOrder(input: CreatePaymentInput): Promise<CheckoutView> {
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt.getTime() <= Date.now())
      throw new ValidationError([{ path: 'body.expiresAt', message: 'must be in the future' }]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.deps.paymentsRepository.liveForOrder(input.orderId);
      if (existing !== null) {
        if (isCaptured(existing))
          throw new ConflictError('This order is already paid', {
            details: { reason: 'ALREADY_PAID', paymentId: existing.id },
          });
        if (existing.amountPaise !== BigInt(input.amountPaise))
          throw new ConflictError('The order amount differs from its open payment', {
            details: { reason: 'AMOUNT_CHANGED', paymentId: existing.id },
          });
        return this.checkoutView(await this.start(existing));
      }
      const created = await this.deps.paymentsRepository.create({
        paymentNo: newNumber('TXN'),
        orderId: input.orderId,
        orderNo: input.orderNo,
        userId: input.userId,
        amountPaise: BigInt(input.amountPaise),
        currency: input.currency,
        provider: input.method === 'WALLET' ? 'WALLET' : this.deps.gateway.name,
        expiresAt,
      });
      if (created !== null) return this.checkoutView(await this.start(created));
      // A concurrent create won the one-live-payment slot: loop and reuse it.
    }
    throw new ConflictError('Concurrent payment creation; retry', {
      details: { reason: 'CONCURRENT_CREATE' },
    });
  }

  /**
   * Internal (wallet-service "Add Money"): the ONE payment of a wallet top-up, idempotent per
   * topupId (unique referenceId). Its outcome is published as payment.topup_*.v1 only.
   */
  async createForTopup(input: CreateTopupPaymentInput): Promise<CheckoutView> {
    const expiresAt = new Date(input.expiresAt);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.deps.paymentsRepository.byReference(input.topupId);
      if (existing !== null) {
        if (existing.userId !== input.userId || existing.amountPaise !== BigInt(input.amountPaise))
          throw new ConflictError('The top-up differs from its payment', {
            details: { reason: 'TOPUP_MISMATCH', paymentId: existing.id },
          });
        return this.checkoutView(
          isOpen(existing) ? await this.ensureGatewayOrder(existing) : existing,
        );
      }
      if (expiresAt.getTime() <= Date.now())
        throw new ValidationError([{ path: 'body.expiresAt', message: 'must be in the future' }]);
      const created = await this.deps.paymentsRepository.create({
        paymentNo: newNumber('TXN'),
        purpose: 'WALLET_TOPUP',
        referenceId: input.topupId,
        userId: input.userId,
        amountPaise: BigInt(input.amountPaise),
        currency: input.currency,
        provider: this.deps.gateway.name,
        expiresAt,
      });
      if (created !== null) return this.checkoutView(await this.ensureGatewayOrder(created));
      // A concurrent create for the same top-up won (unique referenceId): loop and reuse it.
    }
    throw new ConflictError('Concurrent payment creation; retry', {
      details: { reason: 'CONCURRENT_CREATE' },
    });
  }

  /** Gateway payments open a gateway order; WALLET payments debit the wallet right away. */
  private start(p: PaymentRow): Promise<PaymentRow> {
    return p.provider === 'WALLET' ? this.payWithWallet(p) : this.ensureGatewayOrder(p);
  }

  /**
   * WALLET provider (D-54): debit the whole amount (idempotent per payment in wallet-service).
   * Debited → the normal capture path (payment.captured.v1, so the order lifecycle is unchanged).
   * Refused (short / frozen) → FAILED (the buyer may top up and pay again until expiresAt).
   * No answer → stays PENDING; liveStatus / the reconcile job settle it.
   */
  private async payWithWallet(p: PaymentRow): Promise<PaymentRow> {
    if (!isOpen(p)) return p;
    let current = p;
    if (current.status === 'CREATED')
      current = await this.deps.runInTransaction(async (tx) => {
        const locked = await this.deps.paymentsRepository.lock(tx, p.id);
        if (locked === null) throw new NotFoundError('Payment');
        return locked.status === 'CREATED'
          ? this.deps.paymentsRepository.update(p.id, { status: 'PENDING' }, tx)
          : locked;
      });
    const { orderId, orderNo } = orderOf(current);
    try {
      const d = await this.deps.walletClient.debit({
        paymentId: current.id,
        userId: current.userId,
        orderId,
        orderNo,
        amountPaise: Number(current.amountPaise),
      });
      return await this.applyGatewayPayment(current.id, walletCapture(d), 'wallet');
    } catch (err) {
      if (err instanceof WalletRefusal && WALLET_REFUSALS.has(err.reason ?? ''))
        return this.applyGatewayPayment(
          current.id,
          walletFailure(current, err.reason ?? 'WALLET_REFUSED', err.message),
          'wallet',
        );
      if (err instanceof ServiceUnavailableError) {
        this.deps.logger.warn({ err, paymentId: current.id }, 'wallet debit outcome unknown');
        return (await this.deps.paymentsRepository.find(current.id)) ?? current;
      }
      throw err;
    }
  }

  /** WALLET: was it debited? (never debits once the window is over) */
  private async walletLiveStatus(p: PaymentRow): Promise<PaymentRow> {
    let d;
    try {
      d = await this.deps.walletClient.debitStatus(p.id);
    } catch (err) {
      throw err instanceof WalletRefusal ? new ExternalServiceError('wallet', { cause: err }) : err;
    }
    if (d.status === 'DEBITED')
      return this.applyGatewayPayment(p.id, walletCapture(d), 'reconcile');
    // Outcome unknown (no answer earlier) and still payable: retry the idempotent debit.
    if (p.status === 'PENDING' && p.expiresAt.getTime() > Date.now()) return this.payWithWallet(p);
    return p;
  }

  /** CREATED → PENDING with a gateway order (only the first writer's gateway order is kept). */
  private async ensureGatewayOrder(p: PaymentRow): Promise<PaymentRow> {
    if (p.providerOrderId !== null) return p;
    let order: { id: string };
    try {
      order = await this.deps.gateway.createOrder({
        amountPaise: Number(p.amountPaise),
        currency: p.currency,
        receipt: p.paymentNo,
        notes:
          p.purpose === 'WALLET_TOPUP'
            ? { purpose: 'wallet_topup', topupId: p.referenceId ?? '', paymentId: p.id }
            : { orderId: p.orderId ?? '', orderNo: p.orderNo ?? '', paymentId: p.id },
      });
    } catch (err) {
      throw gatewayFailure(err);
    }
    return this.deps.runInTransaction(async (tx) => {
      const locked = await this.deps.paymentsRepository.lock(tx, p.id);
      if (locked === null) throw new NotFoundError('Payment');
      if (locked.providerOrderId !== null) return locked;
      return this.deps.paymentsRepository.update(
        p.id,
        {
          providerOrderId: order.id,
          status: locked.status === 'CREATED' ? 'PENDING' : locked.status,
        },
        tx,
      );
    });
  }

  checkoutView(p: PaymentRow): CheckoutView {
    return {
      paymentId: p.id,
      paymentNo: p.paymentNo,
      status: p.status,
      provider: p.provider,
      keyId: this.deps.gateway.keyId,
      providerOrderId: p.providerOrderId,
      amountPaise: Number(p.amountPaise),
      amount: rupees(p.amountPaise),
      currency: p.currency,
      expiresAt: p.expiresAt,
    };
  }

  // ── Customer ──

  async getForUser(user: AuthUser, id: string): Promise<PaymentView> {
    return toPaymentView(await this.owned(user, id));
  }

  /** Checkout callback: signature (constant time) → gateway fetch → apply. Idempotent. */
  async verify(user: AuthUser, id: string, input: VerifyInput): Promise<PaymentView> {
    const p = await this.owned(user, id);
    if (p.providerOrderId === null || p.providerOrderId !== input.providerOrderId)
      throw new ValidationError(
        [{ path: 'body.providerOrderId', message: 'does not belong to this payment' }],
        'Payment / gateway order mismatch',
      );
    if (
      !this.deps.gateway.verifyCheckoutSignature(
        p.providerOrderId,
        input.providerPaymentId,
        input.signature,
      )
    ) {
      this.deps.logger.warn({ paymentId: id }, 'checkout signature mismatch');
      throw new BadRequestError('Invalid payment signature', {
        details: { reason: 'SIGNATURE_INVALID' },
      });
    }
    let gp: GatewayPayment;
    try {
      gp = await this.deps.gateway.fetchPayment(input.providerPaymentId);
    } catch (err) {
      throw gatewayFailure(err);
    }
    if (gp.orderId !== p.providerOrderId)
      throw new ValidationError(
        [{ path: 'body.providerPaymentId', message: 'belongs to another gateway order' }],
        'Payment / gateway order mismatch',
      );
    return toPaymentView(await this.applyGatewayPayment(p.id, gp, 'verify'));
  }

  /**
   * Mock gateway only: the buyer "pays" (or fails) in the mock checkout. Returns the same callback
   * Razorpay returns to the app, and stores a correctly signed webhook (processed by the job), so
   * the real verify + webhook paths run.
   */
  async mockPay(user: AuthUser, id: string, input: MockPayInput, outcome: 'captured' | 'failed') {
    const gateway = this.deps.gateway;
    if (!(gateway instanceof MockGateway)) throw new NotFoundError('Route');
    const p = await this.owned(user, id);
    if (!isOpen(p) || p.providerOrderId === null)
      throw new ConflictError(`Payment is ${p.status}`, {
        details: { reason: 'NOT_PAYABLE', status: p.status },
      });
    if (p.expiresAt.getTime() <= Date.now())
      throw new ConflictError('The payment window has ended', { details: { reason: 'EXPIRED' } });
    const { payment, signature } = await gateway.simulatePayment({
      orderId: p.providerOrderId,
      amountPaise: Number(p.amountPaise),
      currency: p.currency,
      outcome,
      method: input.method ?? 'upi',
    });
    await this.deps.webhooksService.receiveMock(
      outcome === 'captured' ? 'payment.captured' : 'payment.failed',
      { payment },
    );
    return outcome === 'captured'
      ? {
          providerOrderId: p.providerOrderId,
          providerPaymentId: payment.id,
          signature,
        }
      : {
          providerOrderId: p.providerOrderId,
          providerPaymentId: payment.id,
          error: { code: payment.errorCode, description: payment.errorReason },
        };
  }

  // ── Gateway outcome (verify, webhook, reconcile) ──

  async applyGatewayPayment(
    paymentId: string,
    gp: GatewayPayment,
    source: 'verify' | 'webhook' | 'reconcile' | 'wallet',
  ): Promise<PaymentRow> {
    return this.deps.runInTransaction(async (tx) => {
      const repo = this.deps.paymentsRepository;
      const p = await repo.lock(tx, paymentId);
      if (p === null) throw new NotFoundError('Payment');
      const isNew = await repo.recordAttempt(tx, {
        paymentId,
        providerPaymentId: gp.id,
        status: gp.status,
        method: gp.method,
        errorCode: gp.errorCode,
        errorReason: gp.errorReason?.slice(0, 300) ?? null,
        source,
      });
      const ctx = `payment:${paymentId}`;

      if (gp.status === 'captured' || gp.status === 'refunded') {
        if (isCaptured(p)) {
          if (p.providerPaymentId !== gp.id)
            this.deps.logger.error(
              { paymentId, first: p.providerPaymentId, second: gp.id },
              'SECOND capture on one gateway order: refund it manually',
            );
          return p;
        }
        // OPEN, CANCELLED or EXPIRED: money moved, so the payment is CAPTURED regardless; the
        // order side decides (late payment on a closed order → automatic refund, docs/oms R5).
        const mismatch = BigInt(gp.amountPaise) !== p.amountPaise || gp.currency !== p.currency;
        const updated = await repo.update(
          paymentId,
          {
            status: 'CAPTURED',
            providerPaymentId: gp.id,
            capturedPaise: BigInt(gp.amountPaise),
            capturedAt: new Date(),
            method: gp.method,
            vpaMasked: maskVpa(gp.vpa),
            cardLast4: gp.cardLast4,
            cardNetwork: gp.cardNetwork,
            bank: gp.bank,
            wallet: gp.wallet,
            amountMismatch: mismatch,
            ...(isNew ? { attemptCount: { increment: 1 } } : {}),
          },
          tx,
        );
        if (mismatch)
          this.deps.logger.error(
            { paymentId, expected: Number(p.amountPaise), captured: gp.amountPaise },
            'captured amount differs from the order amount',
          );
        await this.emitCaptured(tx, updated, gp, ctx);
        return updated;
      }

      if (gp.status === 'failed' && isNew && isOpen(p)) {
        const updated = await repo.update(
          paymentId,
          {
            status: 'FAILED',
            failureCode: gp.errorCode,
            failureReason: gp.errorReason?.slice(0, 300) ?? null,
            attemptCount: { increment: 1 },
          },
          tx,
        );
        if (p.purpose === 'WALLET_TOPUP')
          await emitPaymentEvent(
            tx,
            PAYMENT_EVENTS.topupFailed,
            {
              paymentId,
              topupId: refOf(p),
              userId: p.userId,
              errorCode: gp.errorCode,
              errorReason: gp.errorReason,
            },
            ctx,
          );
        else
          await emitPaymentEvent(
            tx,
            PAYMENT_EVENTS.failed,
            {
              paymentId,
              orderId: orderOf(p).orderId,
              errorCode: gp.errorCode,
              errorReason: gp.errorReason,
            },
            ctx,
          );
        return updated;
      }
      return p; // created / authorized (auto-capture follows) or a replayed failure
    });
  }

  /** Order payments → payment.captured.v1 (order-service); top-ups → payment.topup_captured.v1. */
  private async emitCaptured(tx: Tx, p: PaymentRow, gp: GatewayPayment, ctx: string) {
    if (p.purpose === 'WALLET_TOPUP') {
      await emitPaymentEvent(
        tx,
        PAYMENT_EVENTS.topupCaptured,
        {
          paymentId: p.id,
          paymentNo: p.paymentNo,
          topupId: refOf(p),
          userId: p.userId,
          amountPaise: gp.amountPaise,
          expectedPaise: Number(p.amountPaise),
          currency: gp.currency,
          method: gp.method,
          bank: p.bank,
          cardLast4: p.cardLast4,
          cardNetwork: p.cardNetwork,
          vpaMasked: p.vpaMasked,
          providerPaymentId: gp.id,
        },
        ctx,
      );
      return;
    }
    const { orderId, orderNo } = orderOf(p);
    await emitPaymentEvent(
      tx,
      PAYMENT_EVENTS.captured,
      {
        paymentId: p.id,
        orderId,
        orderNo,
        amountPaise: gp.amountPaise,
        currency: gp.currency,
        expectedPaise: Number(p.amountPaise),
        method: gp.method,
        providerPaymentId: gp.id,
      },
      ctx,
    );
  }

  /** Re-reads the gateway for an open payment (lost webhook guard; order timeout check). */
  async liveStatus(id: string): Promise<PaymentRow> {
    const p = await this.deps.paymentsRepository.find(id);
    if (p === null) throw new NotFoundError('Payment');
    if (!isOpen(p)) return p;
    if (p.provider === 'WALLET') return this.walletLiveStatus(p);
    if (p.providerOrderId === null) return p;
    let attempts: GatewayPayment[];
    try {
      attempts = await this.deps.gateway.fetchOrderPayments(p.providerOrderId);
    } catch (err) {
      throw gatewayFailure(err);
    }
    // Captured first (it wins), then failures in order.
    const ordered = [
      ...attempts.filter((a) => a.status === 'captured' || a.status === 'refunded'),
      ...attempts.filter((a) => a.status === 'failed'),
    ];
    let current = p;
    for (const gp of ordered) current = await this.applyGatewayPayment(p.id, gp, 'reconcile');
    return current;
  }

  // ── Order lifecycle ──

  /** Void an open payment (order cancelled / rejected / failed). A later capture is still recorded. */
  async cancel(id: string, reason: string): Promise<PaymentRow> {
    return this.deps.runInTransaction(async (tx) => {
      const p = await this.deps.paymentsRepository.lock(tx, id);
      if (p === null) throw new NotFoundError('Payment');
      if (p.status === 'CANCELLED' || p.status === 'EXPIRED') return p;
      if (!isOpen(p))
        throw new ConflictError(`Payment is ${p.status}`, {
          details: { reason: 'NOT_CANCELLABLE', status: p.status },
        });
      return this.voidInTx(tx, p, reason);
    });
  }

  async onOrderClosedInTx(tx: Tx, orderId: string, reasonCode: string): Promise<void> {
    const live = await this.deps.paymentsRepository.liveForOrder(orderId, tx);
    if (live === null) return;
    const p = await this.deps.paymentsRepository.lock(tx, live.id);
    if (p !== null && isOpen(p)) await this.voidInTx(tx, p, `Order closed: ${reasonCode}`);
  }

  private voidInTx(tx: Tx, p: PaymentRow, reason: string): Promise<PaymentRow> {
    return this.deps.paymentsRepository.update(
      p.id,
      { status: 'CANCELLED', cancelledAt: new Date(), failureReason: reason.slice(0, 300) },
      tx,
    );
  }

  // ── Jobs ──

  /** Open payments older than reconcileAfterSeconds → gateway refetch. */
  async reconcilePending(): Promise<{ checked: number }> {
    const { reconcileAfterSeconds } = await this.deps.settingsService.current();
    const due = await this.deps.paymentsRepository.openOlderThan(
      new Date(Date.now() - reconcileAfterSeconds * 1000),
      JOB_BATCH,
    );
    for (const p of due) {
      await this.liveStatus(p.id).catch((err: unknown) => {
        this.deps.logger.warn({ err, paymentId: p.id }, 'reconcile failed; next run retries');
      });
    }
    return { checked: due.length };
  }

  /** Past expiresAt: a live gateway check first; only a still-open payment expires. */
  async expireDue(): Promise<{ expired: number }> {
    let expired = 0;
    for (const p of await this.deps.paymentsRepository.openExpired(JOB_BATCH)) {
      if (p.providerOrderId !== null || p.provider === 'WALLET') {
        const ok = await this.liveStatus(p.id).then(
          () => true,
          (err: unknown) => {
            this.deps.logger.warn({ err, paymentId: p.id }, 'expiry check failed; retry later');
            return false;
          },
        );
        if (!ok) continue;
      }
      const done = await this.deps.runInTransaction(async (tx) => {
        const locked = await this.deps.paymentsRepository.lock(tx, p.id);
        if (locked === null || !isOpen(locked)) return false;
        await this.deps.paymentsRepository.update(
          p.id,
          { status: 'EXPIRED', expiredAt: new Date() },
          tx,
        );
        if (p.purpose === 'WALLET_TOPUP')
          await emitPaymentEvent(
            tx,
            PAYMENT_EVENTS.topupExpired,
            { paymentId: p.id, topupId: refOf(p), userId: p.userId },
            `payment:${p.id}`,
          );
        else
          await emitPaymentEvent(
            tx,
            PAYMENT_EVENTS.expired,
            { paymentId: p.id, orderId: orderOf(p).orderId },
            `payment:${p.id}`,
          );
        return true;
      });
      if (done) expired += 1;
    }
    return { expired };
  }

  // ── Refund support (refunds feature, inside its transaction) ──

  lockInTx(tx: Tx, id: string): Promise<PaymentRow | null> {
    return this.deps.paymentsRepository.lock(tx, id);
  }

  /** Adds a completed refund to the payment totals (caller holds the payment lock). */
  recordRefundedInTx(tx: Tx, p: PaymentRow, amountPaise: bigint): Promise<PaymentRow> {
    const refunded = p.refundedPaise + amountPaise;
    return this.deps.paymentsRepository.update(
      p.id,
      {
        refundedPaise: refunded,
        status: refunded >= p.capturedPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      },
      tx,
    );
  }

  // ── Reads ──

  async get(id: string): Promise<PaymentRow> {
    const p = await this.deps.paymentsRepository.find(id);
    if (p === null) throw new NotFoundError('Payment');
    return p;
  }

  byProviderOrder(providerOrderId: string): Promise<PaymentRow | null> {
    return this.deps.paymentsRepository.byProviderOrder(providerOrderId);
  }

  async list(query: PaymentListQuery): Promise<Paginated<PaymentView>> {
    const page = await this.deps.paymentsRepository.list(query);
    return { ...page, items: page.items.map(toPaymentView) };
  }

  attempts(id: string): Promise<AttemptView[]> {
    return this.deps.paymentsRepository.attempts(id);
  }

  /** Admin reconcile: refetch from the gateway now (audited). */
  async adminReconcile(actor: Actor, id: string): Promise<PaymentView> {
    const before = await this.get(id);
    const after = await this.liveStatus(id);
    await this.deps.runInTransaction((tx) =>
      this.deps.auditService.record(tx, actor, {
        action: 'payment.reconcile',
        targetType: 'payment',
        targetId: id,
        before: { status: before.status },
        after: { status: after.status },
      }),
    );
    return toPaymentView(after);
  }

  private async owned(user: AuthUser, id: string): Promise<PaymentRow> {
    const p = await this.deps.paymentsRepository.find(id);
    // Someone else's payment answers exactly like a missing one (no existence leak).
    if (p?.userId !== user.id) throw new NotFoundError('Payment');
    return p;
  }
}
