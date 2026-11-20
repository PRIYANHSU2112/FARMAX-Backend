import type { PublicReviewRecord, ReportRecord, ReviewRecord } from './reviews.repository.js';
import { isAuthorEditable } from './reviews.status.js';
import type {
  AdminReviewView,
  MyReviewView,
  PublicReviewView,
  ReportView,
  ReviewImage,
} from './reviews.types.js';

type ProductRef = { name: string; slug: string } | null;

const imagesOf = (raw: unknown): ReviewImage[] =>
  Array.isArray(raw) ? (raw as ReviewImage[]) : [];

/** Storefront shape: no user id, order id, status or moderation data. */
export const toPublicReview = (r: PublicReviewRecord): PublicReviewView => ({
  id: r.id,
  productId: r.productId,
  variantId: r.variantId,
  authorName: r.authorName,
  rating: r.rating,
  title: r.title,
  body: r.body,
  images: imagesOf(r.images),
  isVerifiedPurchase: true,
  helpfulCount: r.helpfulCount,
  isEdited: r.editCount > 0,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export const toMyReview = (
  r: ReviewRecord,
  product: ProductRef,
  maxEdits: number,
): MyReviewView => ({
  ...toPublicReview(r),
  status: r.status,
  orderId: r.orderId,
  moderationReason: r.status === 'REJECTED' || r.status === 'HIDDEN' ? r.moderationReason : null,
  product,
  editCount: r.editCount,
  canEdit: isAuthorEditable(r.status) && r.editCount < maxEdits,
  version: r.version,
});

export const toAdminReview = (r: ReviewRecord, product: ProductRef): AdminReviewView => ({
  id: r.id,
  productId: r.productId,
  product,
  variantId: r.variantId,
  orderId: r.orderId,
  userId: r.userId,
  authorName: r.authorName,
  rating: r.rating,
  title: r.title,
  body: r.body,
  images: imagesOf(r.images),
  status: r.status,
  flags: r.flags,
  moderationReason: r.moderationReason,
  helpfulCount: r.helpfulCount,
  reportCount: r.reportCount,
  openReportCount: r.openReportCount,
  editCount: r.editCount,
  publishedAt: r.publishedAt,
  moderatedByUserId: r.moderatedByUserId,
  moderatedAt: r.moderatedAt,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  deletedAt: r.deletedAt,
});

export const toReport = (r: ReportRecord): ReportView => ({ ...r });
