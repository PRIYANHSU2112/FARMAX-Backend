/**
 * Event contracts PUBLISHED by wallet-service (D-54; docs/wallet). Ids and amounts only, never PII.
 * Money is integer PAISE. Consumers: notification-service (future).
 */
import type { EventEnvelope } from '../envelope.js';

export const WALLET_EVENT_SOURCE = 'wallet-service';

export const WALLET_EVENTS = {
  transactionPosted: 'wallet.transaction_posted.v1',
  pointsPosted: 'points.transaction_posted.v1',
  pointsExpiringSoon: 'points.expiring_soon.v1',
} as const;

export type WalletEventType = (typeof WALLET_EVENTS)[keyof typeof WALLET_EVENTS];

/** One journal moved a customer's wallet balance (sent once per journal, in its transaction). */
export interface WalletTransactionPostedV1 {
  journalId: string;
  journalNo: string;
  userId: string;
  /** TOPUP · ORDER_DEBIT · REFUND_CREDIT · POINTS_CONVERSION · ADJUSTMENT_CREDIT · ADJUSTMENT_DEBIT · REVERSAL */
  kind: string;
  /** TOPUPS · PURCHASES · REFUNDS · REWARDS · ADJUSTMENTS */
  category: string;
  direction: 'CREDIT' | 'DEBIT';
  amountPaise: number;
  balanceAfterPaise: number;
  refType: string | null;
  refId: string | null;
}

/** One points journal changed a customer's reward points. */
export interface PointsTransactionPostedV1 {
  journalId: string;
  journalNo: string;
  userId: string;
  /** EARN · CASHBACK · MATURE · CONVERT · EXPIRE · REVERSAL · ADJUSTMENT */
  kind: string;
  /** Signed change of the customer's points (+ earned, − spent / expired / reversed). */
  deltaPts: number;
  availableAfter: number;
  pendingAfter: number;
  refType: string | null;
  refId: string | null;
}

/** Points will expire soon (once per lot; the notice window is a wallet setting). */
export interface PointsExpiringSoonV1 {
  userId: string;
  points: number;
  expiresAt: string;
}

export interface WalletEventMap {
  'wallet.transaction_posted.v1': WalletTransactionPostedV1;
  'points.transaction_posted.v1': PointsTransactionPostedV1;
  'points.expiring_soon.v1': PointsExpiringSoonV1;
}

export type WalletEvent<T extends WalletEventType = WalletEventType> = EventEnvelope<
  T,
  WalletEventMap[T]
>;
