import { rupees } from '../ledger/index.js';

export type AdjustmentLedger = 'WALLET' | 'POINTS';
export type AdjustmentDirection = 'CREDIT' | 'DEBIT';
export type AdjustmentCategory = 'GOODWILL' | 'DAMAGE_CLAIM' | 'LOYALTY_BONUS' | 'CORRECTION';
export type AdjustmentStatus = 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED';

export interface AdjustmentRow {
  id: string;
  adjustmentNo: string;
  userId: string;
  ledger: AdjustmentLedger;
  direction: AdjustmentDirection;
  amount: bigint;
  category: AdjustmentCategory;
  title: string;
  reason: string;
  status: AdjustmentStatus;
  requestedBy: string;
  idempotencyKey: string;
  requestHash: string;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  journalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAdjustmentInput {
  userId: string;
  ledger: AdjustmentLedger;
  direction: AdjustmentDirection;
  /** Paise (WALLET) or points (POINTS). */
  amount: number;
  category: AdjustmentCategory;
  /** Statement line, e.g. "Cold Box Damage Refund". */
  title: string;
  reason: string;
}

export interface AdjustmentListQuery {
  status?: AdjustmentStatus;
  userId?: string;
  cursor?: string;
  limit: number;
}

/** Statement chip of a posted wallet adjustment. */
export const CATEGORY_OF: Record<AdjustmentCategory, 'REFUNDS' | 'REWARDS' | 'ADJUSTMENTS'> = {
  GOODWILL: 'ADJUSTMENTS',
  DAMAGE_CLAIM: 'REFUNDS',
  LOYALTY_BONUS: 'REWARDS',
  CORRECTION: 'ADJUSTMENTS',
};

/** Statement subtitle ("Loyalty reward"). */
export const LABEL_OF: Record<AdjustmentCategory, string> = {
  GOODWILL: 'Goodwill credit',
  DAMAGE_CLAIM: 'Damage claim',
  LOYALTY_BONUS: 'Loyalty reward',
  CORRECTION: 'Correction',
};

export const toAdjustmentView = (a: AdjustmentRow) => ({
  id: a.id,
  adjustmentNo: a.adjustmentNo,
  userId: a.userId,
  ledger: a.ledger,
  direction: a.direction,
  amount: Number(a.amount),
  /** "1120.00" for WALLET, null for POINTS. */
  amountRupees: a.ledger === 'WALLET' ? rupees(a.amount) : null,
  category: a.category,
  title: a.title,
  reason: a.reason,
  status: a.status,
  requestedBy: a.requestedBy,
  decidedBy: a.decidedBy,
  decisionReason: a.decisionReason,
  decidedAt: a.decidedAt,
  journalId: a.journalId,
  createdAt: a.createdAt,
});

export type AdjustmentView = ReturnType<typeof toAdjustmentView>;
