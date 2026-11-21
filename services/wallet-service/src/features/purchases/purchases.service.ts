import { AppError, ErrorCode } from '@farmx/common/errors';
import { advisoryXactLock } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { CreditInput, CreditView, DebitInput, DebitView } from './purchases.types.js';

type Deps = Pick<Cradle, 'ledgerService' | 'runInTransaction'>;

const conflict = (message: string, reason: string, extra: object = {}) =>
  new AppError(ErrorCode.CONFLICT, message, 409, { details: { reason, ...extra } });

const payKey = (paymentId: string) => `pay:${paymentId}`;

/**
 * Orders paid from the wallet (D-54, wallet-only checkout). payment-service is the only caller
 * (`/internal/wallet/*`): it debits once per payment (key pay:<paymentId>) and gives refunds back
 * once per refund (key refund:<refundId>), never more than was debited for that payment.
 */
export class PurchasesService {
  constructor(private readonly deps: Deps) {}

  /** Debits the whole order amount. 409 INSUFFICIENT_BALANCE / ACCOUNT_FROZEN; a retry replays. */
  async debit(input: DebitInput): Promise<DebitView> {
    const r = await this.deps.runInTransaction((tx) =>
      this.deps.ledgerService.post(tx, {
        idempotencyKey: payKey(input.paymentId),
        userId: input.userId,
        kind: 'ORDER_DEBIT',
        category: 'PURCHASES',
        direction: 'DEBIT',
        amountPaise: BigInt(input.amountPaise),
        counterparty: 'ORDER_SETTLEMENT',
        title: 'Used at Checkout',
        subtitle: input.orderNo,
        refType: 'PAYMENT',
        refId: input.paymentId,
        metadata: { orderId: input.orderId, orderNo: input.orderNo },
        correlationId: `payment:${input.paymentId}`,
      }),
    );
    return {
      status: 'DEBITED',
      paymentId: input.paymentId,
      journalId: r.journal.id,
      journalNo: r.journal.journalNo,
      amountPaise: Number(r.journal.amountPaise),
      refundedPaise: 0,
      balanceAfterPaise: Number(r.balanceAfterPaise),
      replayed: r.replayed,
    };
  }

  /** Did this payment's debit happen? (payment-service live check / reconcile; never moves money) */
  async debitStatus(paymentId: string): Promise<DebitView> {
    return this.deps.runInTransaction(async (tx) => {
      const j = await this.deps.ledgerService.journalByKey(payKey(paymentId), tx);
      if (j === null)
        return {
          status: 'NONE',
          paymentId,
          journalId: null,
          journalNo: null,
          amountPaise: 0,
          refundedPaise: 0,
          balanceAfterPaise: null,
          replayed: false,
        };
      const refunded = await this.deps.ledgerService.refundedForPaymentInTx(tx, paymentId);
      return {
        status: 'DEBITED',
        paymentId,
        journalId: j.id,
        journalNo: j.journalNo,
        amountPaise: Number(j.amountPaise),
        refundedPaise: Number(refunded),
        balanceAfterPaise: null,
        replayed: true,
      };
    });
  }

  /**
   * Refund to the wallet. Serialised per payment, so parallel refunds can never together exceed
   * the debit (409 EXCEEDS_DEBIT). A retried refund id replays the first credit.
   */
  async credit(input: CreditInput): Promise<CreditView> {
    return this.deps.runInTransaction(async (tx) => {
      const ledger = this.deps.ledgerService;
      await advisoryXactLock(tx, `wallet-pay:${input.paymentId}`);
      const amount = BigInt(input.amountPaise);
      const done = await ledger.journalByKey(`refund:${input.refundId}`, tx);
      if (done === null) {
        const debit = await ledger.journalByKey(payKey(input.paymentId), tx);
        if (debit?.kind !== 'ORDER_DEBIT')
          throw conflict('This payment was not paid from the wallet', 'NO_WALLET_DEBIT');
        if (debit.userId !== input.userId)
          throw conflict('The refund customer differs from the payer', 'USER_MISMATCH');
        const refunded = await ledger.refundedForPaymentInTx(tx, input.paymentId);
        if (refunded + amount > debit.amountPaise)
          throw conflict('The refund exceeds what was paid from the wallet', 'EXCEEDS_DEBIT', {
            debitedPaise: Number(debit.amountPaise),
            refundedPaise: Number(refunded),
          });
      }
      const r = await ledger.post(tx, {
        idempotencyKey: `refund:${input.refundId}`,
        userId: input.userId,
        kind: 'REFUND_CREDIT',
        category: 'REFUNDS',
        direction: 'CREDIT',
        amountPaise: amount,
        counterparty: 'ORDER_SETTLEMENT',
        title: 'Refund',
        subtitle: input.reason.slice(0, 200),
        refType: 'PAYMENT',
        refId: input.paymentId,
        metadata: { refundId: input.refundId },
        correlationId: `refund:${input.refundId}`,
      });
      return {
        refundId: input.refundId,
        journalId: r.journal.id,
        journalNo: r.journal.journalNo,
        amountPaise: Number(r.journal.amountPaise),
        balanceAfterPaise: Number(r.balanceAfterPaise),
        replayed: r.replayed,
      };
    });
  }

  /** Balance for the checkout pre-check (the debit itself stays authoritative). */
  async balance(userId: string) {
    const b = await this.deps.ledgerService.balanceOf(userId);
    return { userId, balancePaise: b.balancePaise, status: b.status };
  }
}
