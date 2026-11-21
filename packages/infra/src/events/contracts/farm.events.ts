/**
 * Event contracts PUBLISHED by farm-service (producer-owned, docs/event-contracts.md).
 * No secrets; no PAN/Aadhaar; personal data only where a consumer needs it to act.
 */
import type { EventEnvelope } from '../envelope.js';

export const FARM_EVENT_SOURCE = 'farm-service';

export const FARM_EVENTS = {
  farmSubmitted: 'farm.submitted.v1',
  farmActivated: 'farm.activated.v1',
  farmReviewRequired: 'farm.review_required.v1',
  farmNeedsAttention: 'farm.needs_attention.v1',
  farmStatusChanged: 'farm.status_changed.v1',
  farmUpdated: 'farm.updated.v1',
  farmMerged: 'farm.merged.v1',
  ownerKycChanged: 'farm.owner_kyc_changed.v1',
  farmFactsChanged: 'farm.facts_changed.v1',
  contentPublished: 'content.published.v1',
  contentCorrected: 'content.corrected.v1',
  contentRetracted: 'content.retracted.v1',
} as const;

export type FarmEventType = (typeof FARM_EVENTS)[keyof typeof FARM_EVENTS];

export type FarmStatusV1 =
  | 'DRAFT'
  | 'UNDER_REVIEW'
  | 'NEEDS_ATTENTION'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'REJECTED'
  | 'MERGED'
  | 'CLOSED';

export interface FarmSubmittedV1 {
  farmId: string;
  ownerId: string;
  category: string;
  channel: string;
}

/** A Farm ID was issued. Consumers: notification (send the pass), loyalty, order read model. */
export interface FarmActivatedV1 {
  farmId: string;
  farmCode: string;
  ownerId: string;
  ownerUserId: string;
  category: string;
  productionTypes: string[];
  territoryCode: string;
  pinCode: string;
  totalBirdCapacity: number | null;
}

export interface FarmReviewRequiredV1 {
  farmId: string;
  caseId: string;
  signals: string[];
  slaDueAt: string;
}

export interface FarmNeedsAttentionV1 {
  farmId: string;
  ownerUserId: string;
  issues: { docType: string; code: string }[];
}

export interface FarmStatusChangedV1 {
  farmId: string;
  from: FarmStatusV1 | null;
  to: FarmStatusV1;
  actorType: 'OWNER' | 'ADMIN' | 'SYSTEM';
}

export interface FarmUpdatedV1 {
  farmId: string;
  changedFields: string[];
}

export interface FarmMergedV1 {
  farmId: string;
  intoFarmId: string;
}

export interface OwnerKycChangedV1 {
  ownerId: string;
  ownerUserId: string;
  kycStatus: 'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
}

/**
 * Full snapshot of the farm facts a read model needs (order-service: offers, coupons, GST).
 * Emitted after EVERY write to the farm row, in the same transaction. `version` is the farm row
 * version after the write (monotonic): consumers ignore a snapshot older than the one they hold.
 */
export interface FarmFactsV1 {
  farmId: string;
  farmCode: string | null;
  ownerUserId: string;
  name: string;
  category: string;
  productionTypes: string[];
  /** Set only through a verified GST lookup (kyc "Invoice as"), so present = verified. */
  gstin: string | null;
  /** True when `gstin` is bound from an ACTIVE GST-portal verification (B2B / ITC billing). */
  gstVerified: boolean;
  /** GST portal "Legal Name of Business" (null when not GST-registered). */
  gstBusinessName: string | null;
  /** GST portal trade name (null when none or not GST-registered). */
  gstTradeName: string | null;
  /** Name printed on tax invoices ("Invoice as …": GST trade name or farm name). */
  invoiceName: string | null;
  /** ISO time of the bound portal check. */
  gstVerifiedAt: string | null;
  /** GST state code: GSTIN prefix, else the farm territory's state. */
  stateCode: string | null;
  territoryCode: string | null;
  pinCode: string | null;
  status: FarmStatusV1;
  version: number;
}

export interface FarmEventMap {
  [FARM_EVENTS.farmSubmitted]: FarmSubmittedV1;
  [FARM_EVENTS.farmActivated]: FarmActivatedV1;
  [FARM_EVENTS.farmReviewRequired]: FarmReviewRequiredV1;
  [FARM_EVENTS.farmNeedsAttention]: FarmNeedsAttentionV1;
  [FARM_EVENTS.farmStatusChanged]: FarmStatusChangedV1;
  [FARM_EVENTS.farmUpdated]: FarmUpdatedV1;
  [FARM_EVENTS.farmMerged]: FarmMergedV1;
  [FARM_EVENTS.ownerKycChanged]: OwnerKycChangedV1;
  [FARM_EVENTS.farmFactsChanged]: FarmFactsV1;
  [FARM_EVENTS.contentPublished]: ContentPublishedV1;
  [FARM_EVENTS.contentCorrected]: ContentCorrectedV1;
  [FARM_EVENTS.contentRetracted]: ContentRetractedV1;
}

export type FarmEvent<T extends FarmEventType = FarmEventType> = EventEnvelope<T, FarmEventMap[T]>;

// ── Content (news feed, disease alerts, knowledge library) ──
// Privacy: no coordinates, farm ids or user ids — only the public place label. Consumers resolve
// readers through farm-service `GET /internal/farms/content/:id/audience` (paged user ids).

export type ContentKindV1 = 'NEWS' | 'ALERT' | 'GUIDE' | 'VIDEO' | 'CHECKLIST' | 'ANNOUNCEMENT';
export type AlertSeverityV1 = 'INFO' | 'WARNING' | 'CRITICAL';

/** Fields every content event carries (the push text + dedupe key inputs). */
export interface ContentEventBaseV1 {
  contentId: string;
  /** Reader-visible version: dedupe key part (redelivery / re-emit never notifies twice). */
  contentVersion: number;
  kind: ContentKindV1;
  severity: AlertSeverityV1 | null;
  title: string;
  /** Public place label ("Tanuku"), never coordinates. */
  placeLabel: string | null;
}

/** A content item went live with `notify` (ALERT by default). Audience: target segment. */
export interface ContentPublishedV1 extends ContentEventBaseV1 {
  summary: string;
}

/** An approved correction was applied with `notify`. Audience: target segment + savers. */
export interface ContentCorrectedV1 extends ContentEventBaseV1 {
  correctionNote: string;
}

/**
 * A live item was withdrawn as wrong. Audience: savers, plus the segment when a push had gone
 * out for it (`wasNotified`).
 */
export interface ContentRetractedV1 extends ContentEventBaseV1 {
  retractNote: string;
  wasNotified: boolean;
}
