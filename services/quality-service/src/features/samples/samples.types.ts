import type { Bucket, SampleStatus } from './samples.rules.js';

export interface SampleCreateInput {
  batchId: string;
  warehouseId: string;
  cnNo?: string;
  qty: number;
  qtyUnit?: string;
  labId?: string;
}

export interface SampleActionInput {
  expectedVersion: number;
  /** collect / send / lab-status: when it happened (default now). */
  at?: string;
  note?: string;
  labRef?: string;
  /** lab-status only. */
  status?: 'ACKNOWLEDGED' | 'TESTING' | 'RESULTS_RECEIVED';
}

export interface SampleListQuery {
  warehouseId?: string;
  bucket?: Bucket;
  status?: SampleStatus;
  labId?: string;
  batchId?: string;
  q?: string;
  cursor?: string;
  limit: number;
}
