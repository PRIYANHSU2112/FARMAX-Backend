/**
 * Event contracts PUBLISHED by order-service for the order lifecycle (docs/oms/06-events.md,
 * D-34…D-45). Defined ahead of the producer (OMS P3/P4) so inventory-service (P1) can consume them.
 * No PII, OTP or secret ever travels in these payloads.
 */
import type { EventEnvelope } from '../envelope.js';

export const ORDER_EVENT_SOURCE = 'order-service';

export const ORDER_EVENTS = {
  placed: 'order.placed.v1',
  paid: 'order.paid.v1',
  rejected: 'order.rejected.v1',
  cancelled: 'order.cancelled.v1',
  failed: 'order.failed.v1',
  refundRequested: 'order.refund_requested.v1',
  confirmed: 'order.confirmed.v1',
  reviewOverdue: 'order.review_overdue.v1',
  /** Defined ahead of its producer (F1 shipments / POD); product-service consumes it today. */
  delivered: 'order.delivered.v1',
  /** D-57b W3.15: delivery address / contact / promise changed before picking. */
  deliveryUpdated: 'order.delivery_updated.v1',
} as const;

export type OrderEventType = (typeof ORDER_EVENTS)[keyof typeof ORDER_EVENTS];

/** Delivery details changed before picking (W3.15). No PII: consumers pull the facts again. */
export interface OrderDeliveryUpdatedV1 {
  orderId: string;
  orderNo: string;
  /** Changed fields (contactName, contactPhone, line1, …, pinCode, deliveryPromise). */
  changes: string[];
  pinCode: string;
  district: string | null;
  deliveryPromise: string | null;
}

/** Placed (PENDING_ADMIN_CONFIRMATION, unpaid). Notifications / analytics. No PII. */
export interface OrderPlacedV1 {
  orderId: string;
  orderNo: string;
  userId: string;
  farmId: string;
  /** Rupees with paise. */
  grandTotal: string;
  paymentDueAt: string;
  /**
   * Delivery destination for warehouse operations (D-56): the address snapshot's name, district
   * and PIN. Absent on events published before it.
   */
  shipTo?: { name: string; district: string | null; pinCode: string };
}

/** Payment captured for an open order → inventory commits the reservation (no expiry). */
export interface OrderPaidV1 {
  orderId: string;
  orderNo: string;
  /** Null when the reservation outcome was unknown at checkout: inventory looks it up by order. */
  reservationId: string | null;
  paymentId: string;
  /** Rupees with paise, e.g. "27821.00". */
  amount: string;
}

/** Stock to give back. FULL = the whole reservation; PARTIAL = only `lines` (partial cancel). */
export interface OrderStockReleaseV1 {
  orderId: string;
  orderNo: string;
  reservationId: string | null;
  scope: 'FULL' | 'PARTIAL';
  lines: { variantId: string; qty: number }[];
  reasonCode: string;
}

export type OrderRejectedV1 = OrderStockReleaseV1;
export type OrderCancelledV1 = OrderStockReleaseV1;
export type OrderFailedV1 = OrderStockReleaseV1;

/**
 * A refund DECISION (D-45). payment-service executes it; `sourceRef` is unique per decision, so
 * re-sending it (retry) never refunds twice.
 */
export interface OrderRefundRequestedV1 {
  sourceRef: string;
  orderId: string;
  paymentId: string;
  amountPaise: number;
  reason: string;
  /** Automatic (late payment, stock rejected …): skips manual approval. */
  isSystem: boolean;
  /** Staff user who decided it (null for system decisions). */
  requestedBy: string | null;
}

/** Admin confirmed a paid order with committed stock → (future) shipments, invoice, notification. */
export interface OrderConfirmedV1 {
  orderId: string;
  orderNo: string;
  reservationId: string | null;
  confirmedAt: string;
  /** Active (not cancelled) quantities. Warehouses come from the reservation (inventory). */
  lines: { lineNo: number; variantId: string; qty: number }[];
}

/** A paid order waited longer than the review SLA (sent once per order) → ops notification. */
export interface OrderReviewOverdueV1 {
  orderId: string;
  orderNo: string;
  waitingMinutes: number;
}

/**
 * Every line of the order reached the buyer (POD done). Producer: F1 shipments (not built yet).
 * product-service turns each line into a review eligibility (verified purchase). Ids only.
 */
export interface OrderDeliveredV1 {
  orderId: string;
  orderNo: string;
  userId: string;
  deliveredAt: string;
  /** Delivered (not cancelled / returned) lines. */
  lines: { lineNo: number; variantId: string; productId: string; qty: number }[];
  /**
   * Money the buyer finally paid for this order (captured − refunded so far), integer paise.
   * Reward points are earned on it (wallet-service, D-54). Producer: F1 shipments.
   */
  netPaidPaise: number;
}

export interface OrderEventMap {
  'order.placed.v1': OrderPlacedV1;
  'order.delivery_updated.v1': OrderDeliveryUpdatedV1;
  'order.paid.v1': OrderPaidV1;
  'order.rejected.v1': OrderRejectedV1;
  'order.cancelled.v1': OrderCancelledV1;
  'order.failed.v1': OrderFailedV1;
  'order.refund_requested.v1': OrderRefundRequestedV1;
  'order.confirmed.v1': OrderConfirmedV1;
  'order.review_overdue.v1': OrderReviewOverdueV1;
  'order.delivered.v1': OrderDeliveredV1;
}

export type OrderEvent<T extends OrderEventType = OrderEventType> = EventEnvelope<
  T,
  OrderEventMap[T]
>;
