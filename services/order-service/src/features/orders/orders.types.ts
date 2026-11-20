export type OrderStatus =
  'PENDING_ADMIN_CONFIRMATION' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED' | 'FAILED';
export type PaymentStatus =
  'PENDING' | 'FAILED' | 'PAID' | 'EXPIRED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
export type StockStatus =
  'PENDING' | 'RESERVED' | 'COMMITTED' | 'RELEASE_REQUESTED' | 'RELEASED' | 'FAILED' | 'REJECTED';
export type RefundStatus =
  'NONE' | 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'ACTION_REQUIRED';
export type RefundRequestStatus =
  'REQUESTED' | 'ACCEPTED' | 'COMPLETED' | 'FAILED' | 'RETRY_REQUESTED' | 'MANUALLY_RESOLVED';
export type FailureCode =
  | 'PAYMENT_NOT_COMPLETED'
  | 'STOCK_UNAVAILABLE'
  | 'STOCK_UNAVAILABLE_AFTER_PAYMENT'
  | 'PLACEMENT_ERROR';
export type RefundSource =
  | 'REJECT'
  | 'CANCEL'
  | 'FAIL'
  | 'STOCK_REJECTED'
  | 'LATE_PAYMENT'
  | 'AUTO_REJECT'
  | 'AMOUNT_MISMATCH';
export type ActorType = 'CUSTOMER' | 'STAFF' | 'SYSTEM' | 'SERVICE';
/** ITEMS = a partial cancel (lines changed, order status unchanged). */
export type StatusField = 'STATUS' | 'PAYMENT' | 'STOCK' | 'REFUND' | 'ITEMS';

export const TERMINAL: readonly OrderStatus[] = ['REJECTED', 'CANCELLED', 'FAILED'];
export const PAID_STATUSES: readonly PaymentStatus[] = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];
export const UNPAID_STATUSES: readonly PaymentStatus[] = ['PENDING', 'FAILED'];

/** Money columns come back as Prisma Decimals; views turn them into "1234.50" strings. */
export interface Money {
  toFixed(digits: number): string;
}

export interface OrderRow {
  id: string;
  orderNo: string;
  userId: string;
  farmId: string;
  channel: string;
  status: OrderStatus;
  failureCode: string | null;
  paymentStatus: PaymentStatus;
  stockStatus: StockStatus;
  refundStatus: RefundStatus;
  paymentException: string | null;
  currency: string;
  itemSubtotal: Money;
  discountTotal: Money;
  taxableAmount: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  freight: Money;
  freightDiscount: Money;
  grandTotal: Money;
  paidAmount: Money;
  refundedAmount: Money;
  priceTrace: unknown;
  billing: unknown;
  deliveryAddress: unknown;
  deliveryPromise: string | null;
  couponCode: string | null;
  cartVersion: number;
  reservationId: string | null;
  activePaymentId: string | null;
  idempotencyKey: string;
  requestHash: string;
  placedAt: Date;
  paymentDueAt: Date;
  paidAt: Date | null;
  confirmedAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
  rejectedAt: Date | null;
  closeReasonCode: string | null;
  closeReason: string | null;
  reviewOverdueAt: Date | null;
  confirmedBy: string | null;
  rejectedBy: string | null;
  cancelledBy: string | null;
  version: number;
  updatedAt: Date;
}

export interface OrderLineRow {
  id: string;
  lineNo: number;
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  hsnCode: string;
  gstRate: Money;
  temperatureClass: string;
  qty: number;
  cancelledQty: number;
  unitPrice: Money;
  lineGross: Money;
  lineDiscount: Money;
  taxableValue: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  lineTotal: Money;
  allocations: unknown;
}

export interface OrderWithLines extends OrderRow {
  lines: OrderLineRow[];
}

export interface StatusEventRow {
  field: string;
  fromValue: string | null;
  toValue: string;
  actorType: string;
  actorId: string | null;
  reasonCode: string | null;
  note: string | null;
  at: Date;
}

export interface NoteRow {
  id: string;
  authorId: string;
  body: string;
  createdAt: Date;
}

export interface AdminOrderQuery {
  cursor?: string;
  limit: number;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  stockStatus?: StockStatus;
  refundStatus?: RefundStatus;
  orderNo?: string;
  farmId?: string;
  userId?: string;
  placedFrom?: Date;
  placedTo?: Date;
}

export type ExceptionType =
  'refund_failed' | 'stock_release_pending' | 'amount_mismatch' | 'late_payment';

export interface CancelInput {
  lines?: { variantId: string; qty: number }[];
  reasonCode: string;
  note?: string;
}

export interface RefundRequestRow {
  id: string;
  orderId: string;
  source: string;
  sourceRef: string;
  paymentId: string;
  amount: Money;
  reason: string;
  isSystem: boolean;
  status: RefundRequestStatus;
  providerRefundId: string | null;
  expectedBy: Date | null;
  completedAt: Date | null;
  arn: string | null;
  failureReason: string | null;
  requestedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Actor {
  type: ActorType;
  id: string | null;
}

export const SYSTEM: Actor = { type: 'SYSTEM', id: null };
export const SERVICE: Actor = { type: 'SERVICE', id: null };

export interface CheckoutInput {
  farmId: string;
  addressId: string;
  cartVersion: number;
  billToGst: boolean;
}

export type OrderTab = 'active' | 'completed' | 'cancelled';

export interface OrderListQuery {
  tab: OrderTab;
  cursor?: string;
  limit: number;
}
