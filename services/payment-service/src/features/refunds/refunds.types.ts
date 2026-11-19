export type RefundStatus =
  | 'CREATED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PROCESSING'
  | 'RETRYING'
  | 'PROCESSED'
  | 'FAILED_FINAL';

export interface RefundRow {
  id: string;
  refundNo: string;
  paymentId: string;
  orderId: string;
  sourceRef: string;
  amountPaise: bigint;
  reason: string;
  isSystem: boolean;
  status: RefundStatus;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  providerRefundId: string | null;
  arn: string | null;
  attempts: number;
  nextRetryAt: Date | null;
  lastError: string | null;
  initiatedAt: Date | null;
  expectedBy: Date | null;
  processedAt: Date | null;
  failedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefundView extends Omit<RefundRow, 'amountPaise'> {
  amountPaise: number;
  amount: string;
}

export interface RefundListQuery {
  cursor?: string;
  limit: number;
  status?: RefundStatus;
  orderId?: string;
}

export interface DecisionInput {
  reason: string;
}

/** Backoff after attempt n (1-based): 1 m, 5 m, 30 m, 2 h, 6 h, 24 h. */
export const REFUND_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000];

export const backoffAfter = (attempt: number): number =>
  REFUND_BACKOFF_MS[Math.min(Math.max(attempt, 1), REFUND_BACKOFF_MS.length) - 1] ?? 86_400_000;
