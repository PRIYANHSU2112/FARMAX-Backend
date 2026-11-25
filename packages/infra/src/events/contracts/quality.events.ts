/**
 * Event contracts PUBLISHED by quality-service (D-60, W16 Sampling & COA). Producer-owned,
 * docs/event-contracts.md. Ids, codes and verdicts only: never names, phones or addresses.
 * Consumers:
 *  - warehouse-service: `spec_changed` (receipt QC-hold policy), `decision_requested` /
 *    `decision_retry_requested` (stock moves, one task per warehouse), `batch_state_changed`
 *    (read copy of the certificate status on the batch).
 *  - notification-service: `coa_published` (watchers), `batch_recalled` (every buyer).
 */
import type { EventEnvelope } from '../envelope.js';

export const QUALITY_EVENT_SOURCE = 'quality-service';

export const QUALITY_EVENTS = {
  specChanged: 'quality.spec_changed.v1',
  decisionRequested: 'quality.decision_requested.v1',
  decisionRetryRequested: 'quality.decision_retry_requested.v1',
  batchStateChanged: 'quality.batch_state_changed.v1',
  coaPublished: 'quality.coa_published.v1',
  batchRecalled: 'quality.batch_recalled.v1',
} as const;

export type QualityEventType = (typeof QUALITY_EVENTS)[keyof typeof QUALITY_EVENTS];

export type QualityReleaseModeV1 = 'MANUFACTURER_COA' | 'INDEPENDENT_COA';
export type QualityDecisionKindV1 = 'RELEASE' | 'QUARANTINE' | 'RECALL';
export type QualityBatchStateV1 = 'PENDING' | 'RELEASED' | 'QUARANTINED' | 'RECALLED';
/** Same values as warehouse `WmsCertificateStatus`. */
export type QualityCertificateStatusV1 =
  'NONE' | 'SAMPLE_REFERENCE' | 'VALID' | 'EXPIRED' | 'REJECTED';

/**
 * Quality policy of one SKU (full snapshot; keep the highest `version`). `holdOnReceipt` = new
 * stock of this SKU lands in QC_HOLD and is released only through quality-service.
 */
export interface QualitySpecChangedV1 {
  variantId: string;
  holdOnReceipt: boolean;
  releaseMode: QualityReleaseModeV1;
  isActive: boolean;
  version: number;
}

/**
 * A QA decision on one batch. warehouse-service plans one task per warehouse holding the batch
 * and moves the stock (RELEASE: QC_HOLD → AVAILABLE; QUARANTINE / RECALL: QC_HOLD + AVAILABLE →
 * QUARANTINED). `stateVersion` orders decisions: a task of an older decision never runs after a
 * newer one (SUPERSEDED).
 */
export interface QualityDecisionRequestedV1 {
  decisionId: string;
  decisionNo: string;
  batchId: string;
  kind: QualityDecisionKindV1;
  stateVersion: number;
  actorUserId: string;
  reason: string;
}

/** Re-run the FAILED warehouse tasks of a decision (same task keys, so never a double move). */
export interface QualityDecisionRetryRequestedV1 {
  decisionId: string;
  batchId: string;
  warehouseIds: string[];
  actorUserId: string;
}

/** Summary of a batch's quality for its read copy in warehouse-service (keep highest version). */
export interface QualityBatchStateChangedV1 {
  batchId: string;
  state: QualityBatchStateV1;
  /** QUARANTINE / RECALL: later receipts of this batch land in QUARANTINED; FEFO skips it. */
  qualityBlocked: boolean;
  certificateStatus: QualityCertificateStatusV1;
  coaRef: string | null;
  version: number;
}

/** An independent COA was approved (published to customers). */
export interface QualityCoaPublishedV1 {
  coaId: string;
  coaNo: string;
  batchId: string;
  batchNo: string;
  variantId: string;
  productName: string;
  verdict: 'PASS' | 'FAIL';
  cnNos: string[];
  /** Users who asked to be told ("Notify me when published"). */
  watcherUserIds: string[];
}

/** A batch was recalled (independent COA failed / QA recall). Every buyer must be told. */
export interface QualityBatchRecalledV1 {
  decisionId: string;
  batchId: string;
  batchNo: string;
  variantId: string;
  productName: string;
  cnNos: string[];
  /** Buyers known so far; later buyers get their own event (deduped per decision × user). */
  buyers: { userId: string; orderId: string; orderNo: string }[];
}

export interface QualityEventMap {
  'quality.spec_changed.v1': QualitySpecChangedV1;
  'quality.decision_requested.v1': QualityDecisionRequestedV1;
  'quality.decision_retry_requested.v1': QualityDecisionRetryRequestedV1;
  'quality.batch_state_changed.v1': QualityBatchStateChangedV1;
  'quality.coa_published.v1': QualityCoaPublishedV1;
  'quality.batch_recalled.v1': QualityBatchRecalledV1;
}

export type QualityEvent<T extends QualityEventType = QualityEventType> = EventEnvelope<
  T,
  QualityEventMap[T]
>;
