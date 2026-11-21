/** Mirrors of the Prisma enums (only the repository imports the database client). */
export const CONTENT_KINDS = [
  'NEWS',
  'ALERT',
  'GUIDE',
  'VIDEO',
  'CHECKLIST',
  'ANNOUNCEMENT',
] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const CONTENT_STATUSES = [
  'DRAFT',
  'IN_REVIEW',
  'SCHEDULED',
  'PUBLISHED',
  'EXPIRED',
  'RETRACTED',
  'ARCHIVED',
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof SEVERITIES)[number];

export const PRODUCTION_TYPES = [
  'LAYER',
  'BROILER',
  'BROILER_BREEDER',
  'LAYER_BREEDER',
  'HATCHERY',
  'FEED_MILL',
  'BACKYARD',
] as const;

export const CTA_TYPES = [
  'PRODUCT',
  'CATEGORY',
  'CONSULT',
  'LAB_TEST',
  'SALES_CALL',
  'DEEP_LINK',
] as const;

export type RevisionStatus = 'PENDING' | 'APPLIED' | 'REJECTED';

// ── Body ──

export type Block =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; style: 'bullet' | 'numbered'; items: string[] }
  | { type: 'callout'; tone: 'info' | 'warning'; text: string }
  | { type: 'image'; url: string; caption?: string | null }
  | { type: 'video'; url: string; durationSec?: number | null };

export interface Source {
  title: string;
  publisher: string;
  url?: string | null;
  /** ISO date (YYYY-MM-DD). */
  referenceDate: string;
}

export interface Cta {
  type: (typeof CTA_TYPES)[number];
  /** Product / category id or deep link; null for CONSULT / LAB_TEST / SALES_CALL. */
  target?: string | null;
  label: string;
  style: 'primary' | 'secondary';
}

export interface Asset {
  url: string;
  mediaId?: string | null;
  kind: 'video' | 'pdf';
  sizeBytes?: number | null;
  durationSec?: number | null;
  pageCount?: number | null;
}

/** Alert area (centre of an area, never a farm). Rounded to 2 decimals (~1 km) on write. */
export interface Area {
  lat: number;
  lng: number;
}

/** The reader-visible, editable fields (create / draft edit / correction). */
export interface ContentFields {
  title: string;
  summary: string;
  heroImageUrl: string | null;
  heroMediaId: string | null;
  blocks: Block[];
  sources: Source[];
  ctas: Cta[];
  tags: string[];
  relatedIds: string[];
  asset: Asset | null;
  severity: AlertSeverity | null;
  placeLabel: string | null;
  area: Area | null;
  productionTypes: string[];
  territoryCodes: string[];
}

export interface CreateInput extends Partial<ContentFields> {
  kind: ContentKind;
  topicId: string;
  title: string;
  summary: string;
  isFeatured?: boolean;
  notify?: boolean;
  expiresAt?: string | null;
}

export type DraftPatch = Partial<ContentFields> & {
  topicId?: string;
  isFeatured?: boolean;
  notify?: boolean;
  expiresAt?: string | null;
};

/** Correction fields (targeting / topic / kind are not corrections). */
export type CorrectionChanges = Partial<Omit<ContentFields, 'productionTypes' | 'territoryCodes'>>;

// ── Rows (repository → service) ──

export interface TopicRow {
  id: string;
  code: string;
  name: string;
  clinical: boolean;
  sortOrder: number;
  isActive: boolean;
  version: number;
}

export interface ReviewerRow {
  id: string;
  userId: string;
  displayName: string;
  qualification: string;
  registrationNo: string;
  verifiedByUserId: string;
  verifiedAt: string;
  validUntil: string;
  isActive: boolean;
  version: number;
}

export interface ContentRow extends ContentFields {
  id: string;
  slug: string;
  kind: ContentKind;
  topic: Pick<TopicRow, 'id' | 'code' | 'name' | 'clinical'>;
  readMinutes: number;
  reviewer: Pick<ReviewerRow, 'id' | 'displayName' | 'qualification' | 'registrationNo'> | null;
  clinicalSignedOffAt: string | null;
  signedOffHash: string | null;
  status: ContentStatus;
  isFeatured: boolean;
  notify: boolean;
  publishAt: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  expiredAt: string | null;
  retractedAt: string | null;
  retractNote: string | null;
  notifiedAt: string | null;
  lastCorrectedAt: string | null;
  correctionNote: string | null;
  contentVersion: number;
  version: number;
  viewCount: number;
  helpfulYes: number;
  helpfulNo: number;
  saveCount: number;
  shareCount: number;
  trendingScore: number;
  createdByUserId: string;
  updatedByUserId: string;
  submittedByUserId: string | null;
  submittedAt: string | null;
  publishedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Card projection (no body) — cached per reader segment; `area` is stripped before responding. */
export interface CardRow {
  id: string;
  slug: string;
  kind: ContentKind;
  topic: { code: string; name: string };
  title: string;
  summary: string;
  heroImageUrl: string | null;
  readMinutes: number;
  publishedAt: string | null;
  isFeatured: boolean;
  severity: AlertSeverity | null;
  placeLabel: string | null;
  area: Area | null;
  assetKind: 'video' | 'pdf' | null;
  durationSec: number | null;
  pageCount: number | null;
  viewCount: number;
}

export interface RevisionRow {
  id: string;
  contentId: string;
  baseVersion: number;
  changes: CorrectionChanges;
  changeNote: string;
  status: RevisionStatus;
  requestedByUserId: string;
  requestedAt: string;
  signedOffById: string | null;
  signedOffAt: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
}

export interface StatusEventRow {
  from: ContentStatus | null;
  to: ContentStatus;
  actorUserId: string | null;
  reason: string | null;
  createdAt: string;
}

// ── Reader views ──

export type DistanceBucket = '<5 km' | '5–10 km' | '10–25 km' | '25–50 km' | '50+ km';

export interface Card extends Omit<CardRow, 'area'> {
  /** Distance from the reader's farm to the alert area, as a bucket (never coordinates). */
  distance: DistanceBucket | null;
  saved: boolean;
}

export interface MyState {
  saved: boolean;
  offline: boolean;
  downloadedVersion: number | null;
  helpful: boolean | null;
}

export interface Detail {
  id: string;
  slug: string;
  kind: ContentKind;
  status: 'PUBLISHED' | 'EXPIRED' | 'RETRACTED';
  topic: { code: string; name: string };
  title: string;
  summary: string | null;
  heroImageUrl: string | null;
  blocks: Block[];
  sources: Source[];
  ctas: Cta[];
  tags: string[];
  asset: Asset | null;
  severity: AlertSeverity | null;
  placeLabel: string | null;
  distance: DistanceBucket | null;
  readMinutes: number;
  reviewer: { name: string; qualification: string; registrationNo: string } | null;
  publishedAt: string | null;
  expiresAt: string | null;
  ended: { at: string } | null;
  correction: { at: string; note: string } | null;
  withdrawn: { at: string; note: string } | null;
  contentVersion: number;
  viewCount: number;
  helpful: { yes: number; no: number };
  related: Card[];
  me: MyState;
}

export interface FeedQuery {
  farmId?: string;
  topic?: string;
  kind?: ContentKind;
  sort: 'latest' | 'trending';
  cursor?: string;
  limit: number;
}

export interface SearchQuery {
  q: string;
  farmId?: string;
  topic?: string;
  kind?: ContentKind;
  cursor?: string;
  limit: number;
}

export interface FeedPage {
  featured: Card[];
  items: Card[];
  nextCursor: string | null;
  limit: number;
}

/** Device-held offline copy reported to `/library/sync`. */
export interface HeldCopy {
  contentId: string;
  version: number;
}

export type SyncAction = 'KEEP' | 'REPLACE' | 'DOWNLOAD' | 'MARK_ENDED' | 'DELETE';

export interface SyncItem {
  contentId: string;
  action: SyncAction;
  contentVersion: number | null;
  /** Full item for REPLACE / DOWNLOAD (same shape as the detail screen). */
  item: Detail | null;
  /** Correction / end / withdrawal note to show. */
  note: string | null;
}

export interface LibraryItem extends Card {
  savedAt: string;
  offline: boolean;
  downloadedVersion: number | null;
  contentVersion: number;
  status: ContentStatus;
  asset: Asset | null;
}

export interface AdminListQuery {
  status?: ContentStatus;
  kind?: ContentKind;
  topic?: string;
  q?: string;
  /** Hours: live alerts expiring within this window. */
  expiringWithin?: number;
  cursor?: string;
  limit: number;
}

export interface PublishInput {
  publishAt?: string;
  notify?: boolean;
  reason?: string;
}
