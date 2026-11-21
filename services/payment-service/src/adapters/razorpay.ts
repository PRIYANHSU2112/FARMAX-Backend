import type { Logger } from '@farmx/common/logger';

import type { PaymentConfig } from '../config/index.js';
import {
  GatewayError,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
  hmacHex,
  safeEqualHex,
} from './gateway.js';

export interface RzpPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: GatewayPayment['status'];
  method: string | null;
  vpa?: string | null;
  card?: { last4?: string; network?: string } | null;
  bank?: string | null;
  wallet?: string | null;
  error_code?: string | null;
  error_description?: string | null;
}

export interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: GatewayRefund['status'];
  acquirer_data?: { arn?: string | null; rrn?: string | null; utr?: string | null } | null;
  notes?: Record<string, string> | unknown[];
}

export const toPayment = (p: RzpPayment): GatewayPayment => ({
  id: p.id,
  orderId: p.order_id,
  amountPaise: p.amount,
  currency: p.currency,
  status: p.status,
  method: p.method,
  vpa: p.vpa ?? null,
  cardLast4: p.card?.last4 ?? null,
  cardNetwork: p.card?.network ?? null,
  bank: p.bank ?? null,
  wallet: p.wallet ?? null,
  errorCode: p.error_code ?? null,
  errorReason: p.error_description ?? null,
});

export const toRefund = (r: RzpRefund): GatewayRefund => ({
  id: r.id,
  paymentId: r.payment_id,
  amountPaise: r.amount,
  status: r.status,
  arn: r.acquirer_data?.arn ?? r.acquirer_data?.utr ?? r.acquirer_data?.rrn ?? null,
  refundId: Array.isArray(r.notes) ? null : (r.notes?.refundId ?? null),
});

/**
 * Razorpay REST API over plain fetch (no SDK). Basic auth with the key id + secret (env only,
 * never logged). Network errors, timeouts, 429 and 5xx are retryable; other 4xx are not.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'RAZORPAY' as const;
  readonly keyId: string;
  private readonly secret: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly auth: string;

  constructor(
    config: Pick<
      PaymentConfig,
      'RAZORPAY_KEY_ID' | 'RAZORPAY_KEY_SECRET' | 'RAZORPAY_WEBHOOK_SECRET' | 'RAZORPAY_API_URL'
    >,
    private readonly logger: Logger,
  ) {
    if (
      config.RAZORPAY_KEY_ID === undefined ||
      config.RAZORPAY_KEY_SECRET === undefined ||
      config.RAZORPAY_WEBHOOK_SECRET === undefined
    )
      throw new Error('Razorpay keys are not configured');
    this.keyId = config.RAZORPAY_KEY_ID;
    this.secret = config.RAZORPAY_KEY_SECRET;
    this.webhookSecret = config.RAZORPAY_WEBHOOK_SECRET;
    this.baseUrl = config.RAZORPAY_API_URL.replace(/\/$/, '');
    this.auth = `Basic ${Buffer.from(`${this.keyId}:${this.secret}`).toString('base64')}`;
  }

  async createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }) {
    const order = await this.call<{ id: string }>('POST', '/orders', {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    });
    return { id: order.id };
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return safeEqualHex(hmacHex(this.secret, `${orderId}|${paymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return safeEqualHex(hmacHex(this.webhookSecret, rawBody), signature);
  }

  async fetchPayment(paymentId: string) {
    return toPayment(
      await this.call<RzpPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`),
    );
  }

  async fetchOrderPayments(orderId: string) {
    const res = await this.call<{ items: RzpPayment[] }>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/payments`,
    );
    return res.items.map(toPayment);
  }

  async refund(input: {
    paymentId: string;
    amountPaise: number;
    refundId: string;
    receipt: string;
  }) {
    return toRefund(
      await this.call<RzpRefund>(
        'POST',
        `/payments/${encodeURIComponent(input.paymentId)}/refund`,
        {
          amount: input.amountPaise,
          speed: 'normal',
          receipt: input.receipt.slice(0, 40),
          notes: { refundId: input.refundId },
        },
      ),
    );
  }

  async fetchRefund(paymentId: string, providerRefundId: string) {
    return toRefund(
      await this.call<RzpRefund>(
        'GET',
        `/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(providerRefundId)}`,
      ),
    );
  }

  async listRefunds(paymentId: string) {
    const res = await this.call<{ items: RzpRefund[] }>(
      'GET',
      `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`,
    );
    return res.items.map(toRefund);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: this.auth,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.warn({ err, path }, 'razorpay unreachable');
      throw new GatewayError('Payment gateway unreachable', true);
    }
    if (res.ok) return (await res.json()) as T;
    const detail = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; description?: string };
    };
    const retryable = res.status === 429 || res.status >= 500;
    this.logger.warn(
      { status: res.status, code: detail.error?.code, path },
      'razorpay call failed',
    );
    throw new GatewayError(
      detail.error?.description ?? `Gateway error ${String(res.status)}`,
      retryable,
      detail.error?.code ?? null,
    );
  }
}
