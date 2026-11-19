export type PaymentStatus =
  | 'CREATED'
  | 'PENDING'
  | 'FAILED'
  | 'CAPTURED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

/** Statuses in which the buyer may still pay (same gateway order). */
export const OPEN_STATUSES: readonly PaymentStatus[] = ['CREATED', 'PENDING', 'FAILED'];
/** Money was taken (refunds may follow). */
export const CAPTURED_STATUSES: readonly PaymentStatus[] = [
  'CAPTURED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
];

/** Row shape inside the service (money in paise as bigint). */
export interface PaymentRow {
  id: string;
  paymentNo: string;
  orderId: string;
  orderNo: string;
  userId: string;
  amountPaise: bigint;
  currency: string;
  capturedPaise: bigint;
  refundedPaise: bigint;
  status: PaymentStatus;
  provider: 'RAZORPAY' | 'MOCK';
  providerOrderId: string | null;
  providerPaymentId: string | null;
  method: string | null;
  vpaMasked: string | null;
  cardLast4: string | null;
  cardNetwork: string | null;
  bank: string | null;
  wallet: string | null;
  expiresAt: Date;
  capturedAt: Date | null;
  failureCode: string | null;
  failureReason: string | null;
  cancelledAt: Date | null;
  expiredAt: Date | null;
  attemptCount: number;
  amountMismatch: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** API view: paise as numbers + rupee strings (bigint never reaches JSON). */
export interface PaymentView {
  id: string;
  paymentNo: string;
  orderId: string;
  orderNo: string;
  status: PaymentStatus;
  provider: 'RAZORPAY' | 'MOCK';
  amountPaise: number;
  amount: string;
  currency: string;
  capturedPaise: number;
  refundedPaise: number;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  method: string | null;
  vpaMasked: string | null;
  cardLast4: string | null;
  cardNetwork: string | null;
  bank: string | null;
  wallet: string | null;
  expiresAt: Date;
  capturedAt: Date | null;
  failureCode: string | null;
  failureReason: string | null;
  attemptCount: number;
  amountMismatch: boolean;
  createdAt: Date;
}

/** What the app needs to open the gateway checkout. */
export interface CheckoutView {
  paymentId: string;
  paymentNo: string;
  status: PaymentStatus;
  provider: 'RAZORPAY' | 'MOCK';
  /** Public gateway key for the checkout SDK. */
  keyId: string;
  providerOrderId: string | null;
  amountPaise: number;
  amount: string;
  currency: string;
  expiresAt: Date;
}

export interface CreatePaymentInput {
  orderId: string;
  orderNo: string;
  userId: string;
  amountPaise: number;
  currency: string;
  /** End of the order's payment window. */
  expiresAt: string;
}

export interface VerifyInput {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export interface MockPayInput {
  method?: 'upi' | 'card' | 'netbanking';
}

export interface PaymentListQuery {
  cursor?: string;
  limit: number;
  status?: PaymentStatus;
  orderId?: string;
  userId?: string;
}

export interface AttemptView {
  id: string;
  providerPaymentId: string;
  status: string;
  method: string | null;
  errorCode: string | null;
  errorReason: string | null;
  source: string;
  createdAt: Date;
}

export const rupees = (paise: bigint | number): string => {
  const p = BigInt(paise);
  const sign = p < 0n ? '-' : '';
  const abs = p < 0n ? -p : p;
  return `${sign}${String(abs / 100n)}.${String(abs % 100n).padStart(2, '0')}`;
};

export const toPaymentView = (p: PaymentRow): PaymentView => ({
  id: p.id,
  paymentNo: p.paymentNo,
  orderId: p.orderId,
  orderNo: p.orderNo,
  status: p.status,
  provider: p.provider,
  amountPaise: Number(p.amountPaise),
  amount: rupees(p.amountPaise),
  currency: p.currency,
  capturedPaise: Number(p.capturedPaise),
  refundedPaise: Number(p.refundedPaise),
  providerOrderId: p.providerOrderId,
  providerPaymentId: p.providerPaymentId,
  method: p.method,
  vpaMasked: p.vpaMasked,
  cardLast4: p.cardLast4,
  cardNetwork: p.cardNetwork,
  bank: p.bank,
  wallet: p.wallet,
  expiresAt: p.expiresAt,
  capturedAt: p.capturedAt,
  failureCode: p.failureCode,
  failureReason: p.failureReason,
  attemptCount: p.attemptCount,
  amountMismatch: p.amountMismatch,
  createdAt: p.createdAt,
});
