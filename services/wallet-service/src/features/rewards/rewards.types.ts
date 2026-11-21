export type PointsKind =
  'EARN' | 'CASHBACK' | 'MATURE' | 'CONVERT' | 'EXPIRE' | 'REVERSAL' | 'ADJUSTMENT';

export type PointsSystemCode =
  'POINTS_ISSUED' | 'POINTS_REDEEMED' | 'POINTS_EXPIRED' | 'POINTS_REVERSED';

export type LotSource = 'ORDER' | 'TOPUP_CASHBACK' | 'ADJUSTMENT';
export type LotStatus = 'PENDING' | 'AVAILABLE' | 'EXHAUSTED' | 'EXPIRED' | 'REVERSED';

export interface PointsAccountRow {
  id: string;
  userId: string | null;
  availablePts: bigint;
  pendingPts: bigint;
  debtPts: bigint;
  lifetimeEarned: bigint;
}

export interface PointsJournalRow {
  id: string;
  journalNo: string;
  kind: PointsKind;
  idempotencyKey: string;
  userId: string;
  points: bigint;
  deltaPts: bigint;
  refType: string | null;
  refId: string | null;
  title: string;
  subtitle: string | null;
  metadata: unknown;
  availableAfter: bigint;
  pendingAfter: bigint;
  debtAfter: bigint;
  createdBy: string | null;
  createdAt: Date;
}

export interface LotRow {
  id: string;
  userId: string;
  sourceType: LotSource;
  sourceRef: string;
  journalId: string;
  basePaise: bigint;
  earnedPts: bigint;
  remainingPts: bigint;
  reversedPts: bigint;
  status: LotStatus;
  availableAt: Date;
  expiresAt: Date;
  expiryNoticeAt: Date | null;
}

/**
 * One points movement of one customer. Bucket deltas are signed (debt: + = the customer owes
 * more). The counterparty SYSTEM account balances the journal; MATURE has none (bucket to bucket).
 */
export interface PointsMove {
  key: string;
  userId: string;
  kind: PointsKind;
  /** Positive size shown in the ledger. */
  points: bigint;
  dAvailable: bigint;
  dPending: bigint;
  dDebt: bigint;
  counterparty: PointsSystemCode | null;
  /** Added to lifetimeEarned (EARN / CASHBACK). */
  earned?: bigint;
  title: string;
  subtitle?: string | null;
  refType?: string | null;
  refId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdBy?: string | null;
  correlationId?: string;
}

export interface RewardsSummary {
  availablePts: number;
  /** "Worth ₹1,842" */
  valuePaise: number;
  value: string;
  pendingPts: number;
  debtPts: number;
  lifetimeEarned: number;
  expiringSoon: { points: number; firstExpiresAt: Date | null; withinDays: number };
  conversion: { pointValuePaise: number; minPoints: number; stepPoints: number; eligible: boolean };
}

export interface PointsEntryView {
  id: string;
  journalNo: string;
  kind: PointsKind;
  /** "+4,805 Pts" / "−5,000 Pts" (0 for MATURE: points moved from pending to available). */
  deltaPts: number;
  points: number;
  title: string;
  subtitle: string | null;
  /** "Bal: 18,420" */
  availableAfter: number;
  pendingAfter: number;
  createdAt: Date;
}

export interface ConvertInput {
  points: number;
}

export interface ConvertView {
  pointsJournalNo: string;
  walletJournalNo: string;
  points: number;
  creditedPaise: number;
  credited: string;
  availablePtsAfter: number;
  walletBalanceAfterPaise: number;
  replayed: boolean;
}

export const toEntryView = (j: PointsJournalRow): PointsEntryView => ({
  id: j.id,
  journalNo: j.journalNo,
  kind: j.kind,
  deltaPts: Number(j.deltaPts),
  points: Number(j.points),
  title: j.title,
  subtitle: j.subtitle,
  availableAfter: Number(j.availableAfter),
  pendingAfter: Number(j.pendingAfter),
  createdAt: j.createdAt,
});
