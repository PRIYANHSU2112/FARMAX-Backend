import type { CursorQuery } from '@farmx/common/types';

export type CaseStatus =
  'OPEN' | 'RESOLVED_SEPARATE' | 'RESOLVED_MERGED' | 'RESOLVED_CHANGES' | 'RESOLVED_REJECTED';
export type OwnerClaim = 'SEPARATE_UNIT' | 'SAME_FARM';
export type Decision = 'APPROVE_SEPARATE' | 'MERGE' | 'REQUEST_CHANGES' | 'REJECT';

export interface CaseView {
  id: string;
  farmId: string;
  matchedFarmId: string;
  matchedOwnerId: string;
  sameOwner: boolean;
  signals: string[];
  score: number;
  distanceM: number | null;
  nameSimilarity: number | null;
  ownerClaim: OwnerClaim | null;
  ownerClaimAt: string | null;
  status: CaseStatus;
  assignedToUserId: string | null;
  slaDueAt: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

export interface QueueQuery extends CursorQuery {
  assignee?: 'me' | 'unassigned';
  overdue?: boolean;
}

export interface Issue {
  docType: string;
  code: string;
  message: string;
}

export interface DecisionInput {
  decision: Decision;
  reason: string;
  issues?: Issue[];
}

export interface VerificationView {
  farmId: string;
  status: string;
  statusLabel: 'Under Review' | 'Needs Attention' | 'Verified' | 'Draft' | 'Closed';
  timeline: { step: number; label: string; done: boolean; at: string | null }[];
  question: {
    caseId: string;
    message: string;
    matchedFarm: { name: string; farmCode: string | null; distanceM: number | null } | null;
    ownerClaim: OwnerClaim | null;
  } | null;
  issues: Issue[];
}
