/**
 * Event contracts PUBLISHED by payment-service (D-37, D-45; docs/oms/06-events.md).
 * Consumers: order-service (paymentStatus, refund lifecycle), notifications (future).
 * Money is integer PAISE. Only masked instrument data; never card / bank details or secrets.
 */
import type { EventEnvelope } from '../envelope.js';

export const PAYMENT_EVENT_SOURCE = 'payment-service';

export const PAYMENT_EVENTS = {
  captured: 'payment.captured.v1',
  failed: 'payment.failed.v1',
  expired: 'payment.expired.v1',
  refundInitiated: 'payment.refund_initiated.v1',
  refundProcessed: 'payment.refund_processed.v1',
  refundFailed: 'payment.refund_failed.v1',
} as const;

export type PaymentEventType = (typeof PAYMENT_EVENTS)[keyof typeof PAYMENT_EVENTS];

/** Money was captured. Sent once per payment, even if the order was already closed (R5). */
export interface PaymentCapturedV1 {
  paymentId: string;
  orderId: string;
  orderNo: string;
  /** What was actually captured (compare with the order total: mismatch → R8). */
  amountPaise: number;
  currency: string;
  /** The amount the payment was created for. */
  expectedPaise: number;
  method: string | null;
  providerPaymentId: string;
}

/** An attempt failed; the buyer may retry until the payment expires. */
export interface PaymentFailedV1 {
  paymentId: string;
  orderId: string;
  errorCode: string | null;
  errorReason: string | null;
}

/** Never paid before expiresAt (after a live gateway check). */
export interface PaymentExpiredV1 {
  paymentId: string;
  orderId: string;
}

/** The gateway accepted the refund (money not yet back with the buyer). */
export interface RefundInitiatedV1 {
  refundId: string;
  sourceRef: string;
  paymentId: string;
  orderId: string;
  amountPaise: number;
  providerRefundId: string;
  expectedBy: string;
}

/** The refund completed (bank reference when the gateway gives one). */
export interface RefundProcessedV1 {
  refundId: string;
  sourceRef: string;
  paymentId: string;
  orderId: string;
  amountPaise: number;
  arn: string | null;
  /** Payment totals after this refund. */
  refundedPaise: number;
  capturedPaise: number;
}

/** Retries are exhausted or the gateway refused for good: needs a person. */
export interface RefundFailedV1 {
  refundId: string;
  sourceRef: string;
  paymentId: string;
  orderId: string;
  amountPaise: number;
  reason: string;
}

export interface PaymentEventMap {
  'payment.captured.v1': PaymentCapturedV1;
  'payment.failed.v1': PaymentFailedV1;
  'payment.expired.v1': PaymentExpiredV1;
  'payment.refund_initiated.v1': RefundInitiatedV1;
  'payment.refund_processed.v1': RefundProcessedV1;
  'payment.refund_failed.v1': RefundFailedV1;
}

export type PaymentEvent<T extends PaymentEventType = PaymentEventType> = EventEnvelope<
  T,
  PaymentEventMap[T]
>;
