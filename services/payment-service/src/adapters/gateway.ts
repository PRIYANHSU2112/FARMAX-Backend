import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The payment gateway port (D-37). payment-service is the ONLY FarmX code that talks to a gateway;
 * everything else goes through this interface (RazorpayGateway in prod, MockGateway in dev/test).
 * Amounts are integer paise.
 */

export type GatewayPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
export type GatewayRefundStatus = 'pending' | 'processed' | 'failed';

export interface GatewayPayment {
  id: string;
  orderId: string | null;
  amountPaise: number;
  currency: string;
  status: GatewayPaymentStatus;
  method: string | null;
  /** Masked before it is stored (see maskVpa). */
  vpa: string | null;
  cardLast4: string | null;
  cardNetwork: string | null;
  bank: string | null;
  wallet: string | null;
  errorCode: string | null;
  errorReason: string | null;
}

export interface GatewayRefund {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: GatewayRefundStatus;
  arn: string | null;
  /** Our refund id (sent as notes.refundId) — used to adopt a refund after a crash. */
  refundId: string | null;
}

/** A gateway call failed. `retryable` = network / timeout / 5xx / 429 (try again later). */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface PaymentGateway {
  readonly name: 'RAZORPAY' | 'MOCK';
  /** Public key the app passes to the gateway checkout SDK. */
  readonly keyId: string;
  createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ id: string }>;
  /** Checkout callback: HMAC_SHA256(orderId + "|" + paymentId, key secret). */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
  /** Webhook: HMAC_SHA256(raw body, webhook secret). */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  fetchOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  refund(input: {
    paymentId: string;
    amountPaise: number;
    refundId: string;
    receipt: string;
  }): Promise<GatewayRefund>;
  fetchRefund(paymentId: string, providerRefundId: string): Promise<GatewayRefund>;
  listRefunds(paymentId: string): Promise<GatewayRefund[]>;
}

export const hmacHex = (secret: string, data: string | Buffer): string =>
  createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time compare of two hex signatures (no early exit, no length leak beyond length). */
export const safeEqualHex = (expected: string, given: string): boolean => {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

/** "venkatesh.r@okhdfc" → "ve***@okhdfc" (never store a full VPA). */
export const maskVpa = (vpa: string | null): string | null => {
  if (vpa === null) return null;
  const at = vpa.indexOf('@');
  if (at < 0) return '***';
  return `${vpa.slice(0, Math.min(2, at))}***${vpa.slice(at)}`.slice(0, 80);
};
