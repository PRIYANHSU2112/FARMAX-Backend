export type DecisionKind = 'RELEASE' | 'QUARANTINE' | 'RECALL';

export interface DecisionInput {
  kind: DecisionKind;
  remarks: string;
  /** media-service upload receipts (photos / PDFs). */
  evidence?: string[];
  expectedVersion: number;
}

export type ItemState = 'REVIEWED' | 'PENDING' | 'FAILED';

export interface ChecklistItem {
  key: 'COA_VERIFIED' | 'SPEC_CHECKED' | 'BATCH_QR_MATCHED' | 'QA_APPROVAL';
  label: string;
  state: ItemState;
  detail: string | null;
}
