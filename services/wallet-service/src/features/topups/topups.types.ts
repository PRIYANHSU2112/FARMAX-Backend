import { rupees } from '../ledger/index.js';

export type TopupStatus = 'CREATED' | 'PENDING' | 'FAILED' | 'COMPLETED' | 'EXPIRED';
export type TopupMethod = 'UPI' | 'NETBANKING' | 'CARD';

/** Open = the customer may still pay (the gateway may still capture). */
export const OPEN_TOPUP: readonly TopupStatus[] = ['CREATED', 'PENDING', 'FAILED'];

export interface TopupRow {
  id: string;
  topupNo: string;
  userId: string;
  amountPaise: bigint;
  currency: string;
  method: TopupMethod;
  status: TopupStatus;
  idempotencyKey: string;
  requestHash: string;
  paymentId: string | null;
  paymentNo: string | null;
  creditedPaise: bigint | null;
  paidMethod: string | null;
  bank: string | null;
  cardLast4: string | null;
  cardNetwork: string | null;
  vpaMasked: string | null;
  failureCode: string | null;
  failureReason: string | null;
  failedAttempts: number;
  cashbackPaise: bigint;
  cashbackPoints: number;
  cashbackGrantedAt: Date | null;
  journalId: string | null;
  balanceAfterPaise: bigint | null;
  expiresAt: Date;
  completedAt: Date | null;
  expiredAt: Date | null;
  lastFailedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTopupInput {
  /** Integer paise. */
  amountPaise: number;
  method: TopupMethod;
}

/**
 * One payment outcome, whatever told us (payment.topup_* event, live status, reconcile job).
 * `referenceId` must be this top-up's id, or the outcome is ignored.
 */
export interface PaymentOutcome {
  paymentId: string;
  paymentNo: string | null;
  referenceId: string | null;
  state: 'OPEN' | 'CAPTURED' | 'FAILED' | 'EXPIRED';
  capturedPaise: number;
  method: string | null;
  bank: string | null;
  cardLast4: string | null;
  cardNetwork: string | null;
  vpaMasked: string | null;
  failureCode: string | null;
  failureReason: string | null;
  /** Events count failed attempts; live reads only set the status. */
  source: 'event' | 'live';
}

/** payment-service PaymentStatus → what it means for a top-up. */
export const outcomeState = (status: string): PaymentOutcome['state'] => {
  switch (status) {
    case 'CAPTURED':
    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
      return 'CAPTURED';
    case 'FAILED':
      return 'FAILED';
    case 'EXPIRED':
    case 'CANCELLED':
      return 'EXPIRED';
    default:
      return 'OPEN';
  }
};

/** "HDFC Bank (**4821)" / "UPI ve***@okhdfc" — masked data only. */
export const instrumentLabel = (t: {
  paidMethod: string | null;
  bank: string | null;
  cardLast4: string | null;
  cardNetwork: string | null;
  vpaMasked: string | null;
}): string | null => {
  if (t.cardLast4 !== null) return `${t.cardNetwork ?? 'Card'} (**${t.cardLast4})`;
  if (t.vpaMasked !== null) return `UPI ${t.vpaMasked}`;
  if (t.bank !== null) return `${t.bank} (Net Banking)`;
  return t.paidMethod === null ? null : t.paidMethod.toUpperCase();
};

export interface CheckoutPayload {
  paymentId: string;
  paymentNo: string;
  provider: string;
  /** Public gateway key for the checkout SDK. */
  keyId: string;
  providerOrderId: string | null;
  amountPaise: number;
  currency: string;
  expiresAt: string;
  /** Razorpay Checkout `method` prefill from the chosen option. */
  preferredMethod: 'upi' | 'netbanking' | 'card';
}

export interface TopupView {
  id: string;
  topupNo: string;
  status: TopupStatus;
  amountPaise: number;
  amount: string;
  method: TopupMethod;
  paymentId: string | null;
  /** "Transaction Ref" of the success modal. */
  paymentNo: string | null;
  creditedPaise: number | null;
  credited: string | null;
  /** "Updated Balance" right after this credit. */
  balanceAfterPaise: number | null;
  balanceAfter: string | null;
  instrument: string | null;
  cashback: {
    paise: number;
    points: number;
    /** NONE · PENDING (decided, not credited yet) · CREDITED (in the points ledger) */
    status: 'NONE' | 'PENDING' | 'CREDITED';
  };
  failure: { code: string | null; reason: string | null; attempts: number } | null;
  expiresAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

export const PREFILL: Record<TopupMethod, CheckoutPayload['preferredMethod']> = {
  UPI: 'upi',
  NETBANKING: 'netbanking',
  CARD: 'card',
};

export const toTopupView = (t: TopupRow): TopupView => ({
  id: t.id,
  topupNo: t.topupNo,
  status: t.status,
  amountPaise: Number(t.amountPaise),
  amount: rupees(t.amountPaise),
  method: t.method,
  paymentId: t.paymentId,
  paymentNo: t.paymentNo,
  creditedPaise: t.creditedPaise === null ? null : Number(t.creditedPaise),
  credited: t.creditedPaise === null ? null : rupees(t.creditedPaise),
  balanceAfterPaise: t.balanceAfterPaise === null ? null : Number(t.balanceAfterPaise),
  balanceAfter: t.balanceAfterPaise === null ? null : rupees(t.balanceAfterPaise),
  instrument: instrumentLabel(t),
  cashback: {
    paise: Number(t.cashbackPaise),
    points: t.cashbackPoints,
    status: t.cashbackPoints === 0 ? 'NONE' : t.cashbackGrantedAt === null ? 'PENDING' : 'CREDITED',
  },
  failure:
    t.failedAttempts > 0 || t.failureCode !== null
      ? { code: t.failureCode, reason: t.failureReason, attempts: t.failedAttempts }
      : null,
  expiresAt: t.expiresAt,
  completedAt: t.completedAt,
  createdAt: t.createdAt,
});

/** Start of today in India (IST = UTC+5:30, no DST): the daily top-up limit window. */
export const istDayStart = (now = new Date()): Date => {
  const IST_MS = 330 * 60_000;
  const ist = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MS);
};

/** First-UPI-top-up cashback (pure): min(amount × bps, max) and its value in points (floored). */
export const cashbackFor = (
  creditedPaise: bigint,
  rule: { percentBps: number; maxPaise: number },
  pointValuePaise: number,
): { paise: bigint; points: number } => {
  const raw = (creditedPaise * BigInt(rule.percentBps)) / 10_000n;
  const paise = raw < BigInt(rule.maxPaise) ? raw : BigInt(rule.maxPaise);
  return { paise, points: Number(paise / BigInt(pointValuePaise)) };
};
