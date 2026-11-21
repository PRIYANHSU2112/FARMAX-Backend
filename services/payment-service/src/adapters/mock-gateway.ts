import { randomBytes } from 'node:crypto';

import { paymentKeys } from '@farmx/infra/redis';
import type { Redis } from '@farmx/infra/redis';

import type { PaymentConfig } from '../config/index.js';
import {
  GatewayError,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
  hmacHex,
  safeEqualHex,
} from './gateway.js';

const TTL_SECONDS = 7 * 24 * 3600;
const id = (prefix: string) => `${prefix}_mock${randomBytes(7).toString('hex')}`;

/**
 * Dev / test gateway (PAYMENT_PROVIDER=mock; refused when APP_ENV=prod). No money moves. It keeps
 * "gateway" state in redis-cache and signs exactly like Razorpay, so the REAL verify, webhook,
 * reconcile and refund code paths run unchanged.
 */
export class MockGateway implements PaymentGateway {
  readonly name = 'MOCK' as const;
  readonly keyId = 'rzp_test_mock';

  constructor(
    private readonly config: Pick<PaymentConfig, 'MOCK_KEY_SECRET' | 'MOCK_WEBHOOK_SECRET'>,
    private readonly redis: () => Redis,
  ) {}

  createOrder() {
    return Promise.resolve({ id: id('order') });
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return safeEqualHex(this.signCheckout(orderId, paymentId), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return safeEqualHex(this.signWebhook(rawBody), signature);
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const raw = await this.redis().get(paymentKeys.mockPayment(paymentId));
    if (raw === null)
      throw new GatewayError('The id provided does not exist', false, 'BAD_REQUEST_ERROR');
    return JSON.parse(raw) as GatewayPayment;
  }

  async fetchOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    const ids = await this.redis().lrange(paymentKeys.mockOrder(orderId), 0, -1);
    return Promise.all(ids.map((p) => this.fetchPayment(p)));
  }

  async refund(input: {
    paymentId: string;
    amountPaise: number;
    refundId: string;
    receipt: string;
  }): Promise<GatewayRefund> {
    const payment = await this.fetchPayment(input.paymentId);
    const done = await this.listRefunds(input.paymentId);
    const refunded = done.reduce((n, r) => n + r.amountPaise, 0);
    if (payment.status !== 'captured' && payment.status !== 'refunded')
      throw new GatewayError('Payment is not captured', false, 'BAD_REQUEST_ERROR');
    if (refunded + input.amountPaise > payment.amountPaise)
      throw new GatewayError(
        'Refund amount exceeds the captured amount',
        false,
        'BAD_REQUEST_ERROR',
      );
    const refund: GatewayRefund = {
      id: id('rfnd'),
      paymentId: input.paymentId,
      amountPaise: input.amountPaise,
      status: 'processed',
      arn: `MOCKARN${randomBytes(5).toString('hex').toUpperCase()}`,
      refundId: input.refundId,
    };
    await this.redis()
      .multi()
      .rpush(paymentKeys.mockRefunds(input.paymentId), JSON.stringify(refund))
      .expire(paymentKeys.mockRefunds(input.paymentId), TTL_SECONDS)
      .exec();
    return refund;
  }

  async fetchRefund(paymentId: string, providerRefundId: string): Promise<GatewayRefund> {
    const found = (await this.listRefunds(paymentId)).find((r) => r.id === providerRefundId);
    if (found === undefined) throw new GatewayError('Refund not found', false, 'BAD_REQUEST_ERROR');
    return found;
  }

  async listRefunds(paymentId: string): Promise<GatewayRefund[]> {
    const rows = await this.redis().lrange(paymentKeys.mockRefunds(paymentId), 0, -1);
    return rows.map((r) => JSON.parse(r) as GatewayRefund);
  }

  // ── Mock-only: what the buyer does in the gateway checkout ──

  /** The buyer pays: a captured gateway payment + the checkout callback Razorpay would return. */
  async simulatePayment(input: {
    orderId: string;
    amountPaise: number;
    currency: string;
    outcome: 'captured' | 'failed';
    method: 'upi' | 'card' | 'netbanking';
  }): Promise<{ payment: GatewayPayment; signature: string }> {
    const payment: GatewayPayment = {
      id: id('pay'),
      orderId: input.orderId,
      amountPaise: input.amountPaise,
      currency: input.currency,
      status: input.outcome,
      method: input.method,
      vpa: input.method === 'upi' ? 'farmer.test@okmock' : null,
      cardLast4: input.method === 'card' ? '4242' : null,
      cardNetwork: input.method === 'card' ? 'Visa' : null,
      bank: input.method === 'netbanking' ? 'SBIN' : null,
      wallet: null,
      errorCode: input.outcome === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      errorReason: input.outcome === 'failed' ? 'Payment declined by the bank (mock)' : null,
    };
    await this.redis()
      .multi()
      .set(paymentKeys.mockPayment(payment.id), JSON.stringify(payment), 'EX', TTL_SECONDS)
      .rpush(paymentKeys.mockOrder(input.orderId), payment.id)
      .expire(paymentKeys.mockOrder(input.orderId), TTL_SECONDS)
      .exec();
    return { payment, signature: this.signCheckout(input.orderId, payment.id) };
  }

  signCheckout(orderId: string, paymentId: string): string {
    return hmacHex(this.config.MOCK_KEY_SECRET, `${orderId}|${paymentId}`);
  }

  signWebhook(rawBody: Buffer | string): string {
    return hmacHex(this.config.MOCK_WEBHOOK_SECRET, rawBody);
  }
}
