export const REVIEW_STATUSES = ['PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REPORT_REASONS = [
  'SPAM',
  'ABUSIVE',
  'OFF_TOPIC',
  'FAKE',
  'PERSONAL_INFO',
  'OTHER',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ['OPEN', 'UPHELD', 'DISMISSED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const MODERATION_ACTIONS = ['approve', 'reject', 'hide', 'restore'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export type PublicReviewSort = 'recent' | 'helpful' | 'rating_high' | 'rating_low';
export type AdminReviewSort =
  'newest' | 'oldest' | 'rating_high' | 'rating_low' | 'helpful' | 'most_reported';

export interface ReviewImage {
  mediaId: string;
  url: string;
}

// ── Inputs ──

export interface CreateReviewInput {
  /** Which delivered order to attach (default: the latest eligible delivery). */
  orderId?: string;
  rating: number;
  title?: string | null;
  body?: string | null;
  images?: ReviewImage[];
}

export type UpdateReviewInput = Partial<Omit<CreateReviewInput, 'orderId'>>;

export interface ReportInput {
  reason: ReportReason;
  note?: string | null;
}

export interface PublicReviewQuery {
  sort?: PublicReviewSort;
  rating?: number;
  withImages?: boolean;
  cursor?: string;
  limit: number;
}

export interface AdminReviewQuery {
  q?: string;
  status?: ReviewStatus;
  rating?: number;
  productId?: string;
  userId?: string;
  orderId?: string;
  hasImages?: boolean;
  flagged?: boolean;
  hasOpenReports?: boolean;
  from?: Date;
  to?: Date;
  sort?: AdminReviewSort;
  cursor?: string;
  limit: number;
}

export interface ReportListQuery {
  status?: ReportStatus;
  reason?: ReportReason;
  reviewId?: string;
  cursor?: string;
  limit: number;
}

export interface AnalyticsQuery {
  from?: Date;
  to?: Date;
  productId?: string;
}

// ── Views ──

export interface PublicReviewView {
  id: string;
  productId: string;
  variantId: string;
  authorName: string;
  rating: number;
  title: string | null;
  body: string | null;
  images: ReviewImage[];
  /** Always true: only delivered purchases can be reviewed. */
  isVerifiedPurchase: true;
  helpfulCount: number;
  isEdited: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MyReviewView extends Omit<PublicReviewView, 'isVerifiedPurchase'> {
  isVerifiedPurchase: true;
  status: ReviewStatus;
  orderId: string;
  /** Shown to the author when the review was rejected or hidden. */
  moderationReason: string | null;
  product: { name: string; slug: string } | null;
  editCount: number;
  canEdit: boolean;
  version: number;
}

export interface AdminReviewView {
  id: string;
  productId: string;
  product: { name: string; slug: string } | null;
  variantId: string;
  orderId: string;
  userId: string;
  authorName: string;
  rating: number;
  title: string | null;
  body: string | null;
  images: ReviewImage[];
  status: ReviewStatus;
  flags: string[];
  moderationReason: string | null;
  helpfulCount: number;
  reportCount: number;
  openReportCount: number;
  editCount: number;
  publishedAt: Date | null;
  moderatedByUserId: string | null;
  moderatedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ReportView {
  id: string;
  reviewId: string;
  userId: string;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}

export interface AdminReviewDetail extends AdminReviewView {
  reports: ReportView[];
}

export interface RatingSummaryView {
  productId: string;
  /** "4.35"; null = no published ratings. */
  ratingAvg: string | null;
  ratingCount: number;
  /** Count per star, 5 → 1. */
  distribution: { stars: 1 | 2 | 3 | 4 | 5; count: number; percent: number }[];
  /** Published reviews with a title or body. */
  textCount: number;
  imageCount: number;
}

export interface PendingReviewView {
  productId: string;
  variantId: string;
  orderId: string;
  orderNo: string;
  deliveredAt: Date;
  /** Last day a review is accepted for this purchase. */
  reviewBy: Date;
  product: { name: string; slug: string } | null;
}
