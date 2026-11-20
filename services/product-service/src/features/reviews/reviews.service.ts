import { createHash } from 'node:crypto';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { type Tx, isUniqueViolation, mapPrismaError } from '@farmx/database';
import { productKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { emitProductEvent } from '../../adapters/events.js';
import { LocalCache } from '../../adapters/local-cache.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { Actor } from '../audit/index.js';
import type { ReviewRecord } from './reviews.repository.js';
import {
  type Contribution,
  REVIEW_LIMITS,
  averageOf,
  compileBannedWords,
  contributionOf,
  dedupeImages,
  distributionOf,
  initialStatus,
  isAllowedImageUrl,
  isZeroDelta,
  moderationFlags,
  sanitizeText,
  statusAfterEdit,
  summaryDelta,
} from './reviews.rules.js';
import { isAuthorEditable } from './reviews.status.js';
import type {
  CreateReviewInput,
  MyReviewView,
  PendingReviewView,
  PublicReviewQuery,
  PublicReviewView,
  RatingSummaryView,
  ReportInput,
  ReviewImage,
  ReviewStatus,
  UpdateReviewInput,
} from './reviews.types.js';
import { toMyReview, toPublicReview } from './reviews.views.js';

type Deps = Pick<
  Cradle,
  | 'reviewsRepository'
  | 'productsService'
  | 'auditService'
  | 'userDirectoryClient'
  | 'runInTransaction'
  | 'redis'
  | 'cache'
  | 'config'
  | 'logger'
>;

const PAGE_TTL_SECONDS = 120;
const SUMMARY_TTL_SECONDS = 600;
const DAY_MS = 86_400_000;

interface ProductRef {
  id: string;
  name: string;
  slug: string;
  reviewable: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Errors (stable `details.reason` codes for the apps) ──

const notEligible = () =>
  new ForbiddenError('Only customers who received this product can review it', {
    details: { reason: 'NOT_ELIGIBLE' },
  });
const windowClosed = (days: number) =>
  new ForbiddenError(`Reviews are accepted up to ${String(days)} days after delivery`, {
    details: { reason: 'REVIEW_WINDOW_CLOSED' },
  });
const alreadyReviewed = (reviewId?: string) =>
  new ConflictError('You have already reviewed this product; edit your review instead', {
    details: { reason: 'ALREADY_REVIEWED', ...(reviewId === undefined ? {} : { reviewId }) },
  });
export const reviewVersionConflict = (current: number) =>
  new ConflictError('The review was changed elsewhere; reload and retry', {
    details: { reason: 'VERSION_CONFLICT', currentVersion: current },
  });

/** What a status change does, beyond the status itself (shared by author, auto and admin paths). */
export interface StatusChange {
  to: ReviewStatus;
  /** Event / audit verb: approve | reject | hide | restore | auto_hide. */
  action: string;
  reason: string | null;
  /** null = the system (auto-hide). */
  moderatorId: string | null;
  flags?: string[];
  /** Close the review's open reports with this outcome (null = leave them). */
  closeReportsAs: 'UPHELD' | 'DISMISSED' | null;
}

/**
 * Reviews: storefront reads (cached), the customer write paths and the shared status/summary
 * mechanics used by moderation. Every write = one transaction (review + eligibility + summary
 * delta + product rating + audit + outbox); caches are dropped after commit.
 */
export class ReviewsService {
  private readonly products = new LocalCache<ProductRef | null>(5_000, 60_000);
  private readonly banned: RegExp | null;

  constructor(private readonly deps: Deps) {
    this.banned = compileBannedWords(deps.config.REVIEW_BANNED_WORDS.split(','));
  }

  private get repo() {
    return this.deps.reviewsRepository;
  }

  // ── Storefront ──

  async publicList(slugOrId: string, q: PublicReviewQuery): Promise<Paginated<PublicReviewView>> {
    const product = await this.visibleProduct(slugOrId);
    const version = await this.listVersion(product.id);
    const hash = createHash('sha1')
      .update(JSON.stringify([q.sort ?? 'recent', q.rating, q.withImages, q.cursor, q.limit]))
      .digest('base64url')
      .slice(0, 16);
    return this.deps.cache.getOrSet(
      productKeys.reviewsPage(product.id, version, hash),
      PAGE_TTL_SECONDS,
      async () => {
        const page = await this.repo.publicPage(product.id, q);
        return { ...page, items: page.items.map(toPublicReview) };
      },
    );
  }

  async summary(slugOrId: string): Promise<RatingSummaryView> {
    const product = await this.visibleProduct(slugOrId);
    return this.deps.cache.getOrSet(
      productKeys.ratingSummary(product.id),
      SUMMARY_TTL_SECONDS,
      () => this.buildSummary(product.id),
    );
  }

  async buildSummary(productId: string): Promise<RatingSummaryView> {
    const s = await this.repo.summary(productId);
    const count = s?.ratingCount ?? 0;
    const stars = s === null ? [0, 0, 0, 0, 0] : [s.star1, s.star2, s.star3, s.star4, s.star5];
    return {
      productId,
      ratingAvg: s === null ? null : averageOf(s.ratingSum, s.ratingCount),
      ratingCount: count,
      distribution: distributionOf(stars, count),
      textCount: s?.textCount ?? 0,
      imageCount: s?.imageCount ?? 0,
    };
  }

  // ── Customer ──

  async pending(
    userId: string,
    query: { cursor?: string; limit: number },
  ): Promise<Paginated<PendingReviewView>> {
    const windowMs = this.deps.config.REVIEW_WINDOW_DAYS * DAY_MS;
    const page = await this.repo.pendingForUser(userId, new Date(Date.now() - windowMs), query);
    const ids = page.items.map((e) => e.productId);
    const [reviewed, names] = await Promise.all([
      this.repo.reviewedProductIds(userId, ids),
      this.deps.productsService.productNames(ids),
    ]);
    return {
      ...page,
      items: page.items
        .filter((e) => !reviewed.has(e.productId))
        .map((e) => ({
          productId: e.productId,
          variantId: e.variantId,
          orderId: e.orderId,
          orderNo: e.orderNo,
          deliveredAt: e.deliveredAt,
          reviewBy: new Date(e.deliveredAt.getTime() + windowMs),
          product: names.get(e.productId) ?? null,
        })),
    };
  }

  async mine(userId: string, query: { cursor?: string; limit: number }) {
    const page = await this.repo.mine(userId, query);
    const names = await this.deps.productsService.productNames(page.items.map((r) => r.productId));
    return {
      ...page,
      items: page.items.map((r) =>
        toMyReview(r, names.get(r.productId) ?? null, this.deps.config.REVIEW_MAX_EDITS),
      ),
    };
  }

  async create(slugOrId: string, input: CreateReviewInput, actor: Actor): Promise<MyReviewView> {
    const product = await this.visibleProduct(slugOrId);
    const userId = actor.userId;
    const existing = await this.repo.liveReviewOf(userId, product.id);
    if (existing !== null) throw alreadyReviewed(existing.id);

    const open = await this.repo.openEligibility(userId, product.id);
    const candidates =
      input.orderId === undefined ? open : open.filter((e) => e.orderId === input.orderId);
    const windowStart = Date.now() - this.deps.config.REVIEW_WINDOW_DAYS * DAY_MS;
    const slot = candidates.find((e) => e.deliveredAt.getTime() >= windowStart);
    if (slot === undefined) {
      throw candidates.length > 0
        ? windowClosed(this.deps.config.REVIEW_WINDOW_DAYS)
        : notEligible();
    }

    const content = this.cleanContent(input);
    const flags = moderationFlags(content, this.banned);
    const status = initialStatus(flags);
    const authorName = await this.deps.userDirectoryClient.maskedName(userId);
    const id = uuidv7();

    const changed = await this.write(async (tx) => {
      await this.repo.insert(tx, {
        id,
        productId: product.id,
        variantId: slot.variantId,
        orderId: slot.orderId,
        userId,
        authorName,
        rating: input.rating,
        title: content.title,
        body: content.body,
        images: content.images,
        status,
        flags,
      });
      if (!(await this.repo.linkEligibility(tx, slot.id, id))) throw alreadyReviewed();
      await this.deps.auditService.record(tx, actor, {
        action: 'review.create',
        targetType: 'review',
        targetId: id,
        after: { productId: product.id, rating: input.rating, status, flags },
      });
      const after = contributionOf({
        status,
        rating: input.rating,
        ...content,
        hasImages: content.images.length > 0,
      });
      return this.syncRating(tx, product.id, null, after, actor.requestId);
    });
    await this.afterChange(product.id, changed);
    return this.myView(id);
  }

  async update(
    id: string,
    input: UpdateReviewInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<MyReviewView> {
    const maxEdits = this.deps.config.REVIEW_MAX_EDITS;
    let productId = '';
    const changed = await this.write(async (tx) => {
      const r = await this.lockOwn(tx, id, actor.userId);
      if (ifMatch !== undefined && ifMatch !== r.version) throw reviewVersionConflict(r.version);
      if (!isAuthorEditable(r.status))
        throw new ConflictError('This review is under moderation and cannot be edited now', {
          details: { reason: 'REVIEW_NOT_EDITABLE', status: r.status },
        });
      if (r.editCount >= maxEdits)
        throw new ConflictError(`A review can be edited at most ${String(maxEdits)} times`, {
          details: { reason: 'EDIT_LIMIT' },
        });
      productId = r.productId;

      const cleaned = this.cleanContent({
        title: input.title === undefined ? r.title : input.title,
        body: input.body === undefined ? r.body : input.body,
        images: input.images ?? (r.images as unknown as ReviewImage[]),
      });
      const rating = input.rating ?? r.rating;
      const flags = moderationFlags(cleaned, this.banned);
      const to = statusAfterEdit(r.status, flags);
      await this.repo.update(
        tx,
        id,
        {
          rating,
          title: cleaned.title,
          body: cleaned.body,
          images: cleaned.images,
          status: to,
          flags,
          editCount: r.editCount + 1,
          ...(to === 'PUBLISHED' && r.publishedAt === null ? { publishedAt: new Date() } : {}),
          ...(to === 'PENDING' ? { moderationReason: null } : {}),
        },
        r,
      );
      await this.deps.auditService.record(tx, actor, {
        action: 'review.edit',
        targetType: 'review',
        targetId: id,
        before: { rating: r.rating, status: r.status, flags: r.flags },
        after: { rating, status: to, flags },
      });
      return this.syncRating(
        tx,
        r.productId,
        contributionOf(r),
        contributionOf({ status: to, rating, ...cleaned, hasImages: cleaned.images.length > 0 }),
        actor.requestId,
      );
    });
    await this.afterChange(productId, changed);
    return this.myView(id);
  }

  async remove(id: string, actor: Actor): Promise<void> {
    let productId = '';
    const changed = await this.write(async (tx) => {
      const r = await this.lockOwn(tx, id, actor.userId);
      productId = r.productId;
      await this.repo.softDelete(tx, id);
      await this.repo.unlinkEligibility(tx, id);
      await this.repo.closeReports(tx, id, 'DISMISSED', {
        userId: null,
        note: 'Review deleted by its author',
      });
      await this.deps.auditService.record(tx, actor, {
        action: 'review.delete',
        targetType: 'review',
        targetId: id,
        before: { rating: r.rating, status: r.status },
      });
      return this.syncRating(tx, r.productId, contributionOf(r), null, actor.requestId);
    });
    await this.afterChange(productId, changed);
  }

  /** Helpful vote on / off (idempotent). Not on your own or a non-published review. */
  async vote(id: string, userId: string, helpful: boolean): Promise<{ helpfulCount: number }> {
    await this.write(async (tx) => {
      const r = await this.repo.lock(tx, id);
      if (r?.status !== 'PUBLISHED') throw new NotFoundError('Review');
      if (r.userId === userId)
        throw new ForbiddenError('You cannot vote on your own review', {
          details: { reason: 'OWN_REVIEW' },
        });
      if (helpful) await this.repo.addVote(tx, id, userId);
      else await this.repo.removeVote(tx, id, userId);
    });
    const r = await this.repo.findLive(id);
    return { helpfulCount: r?.helpfulCount ?? 0 };
  }

  votedIds(userId: string, reviewIds: readonly string[]): Promise<string[]> {
    return this.repo.votedIds(userId, reviewIds);
  }

  /** Report a published review (once per user). N open reports auto-hide it. */
  async report(id: string, input: ReportInput, actor: Actor): Promise<{ reportId: string }> {
    const reportId = uuidv7();
    const threshold = this.deps.config.REVIEW_AUTO_HIDE_REPORTS;
    let productId = '';
    const changed = await this.write(
      async (tx) => {
        const r = await this.repo.lock(tx, id);
        if (r?.status !== 'PUBLISHED') throw new NotFoundError('Review');
        if (r.userId === actor.userId)
          throw new ForbiddenError('You cannot report your own review', {
            details: { reason: 'OWN_REVIEW' },
          });
        productId = r.productId;
        await this.repo.insertReport(tx, {
          id: reportId,
          reviewId: id,
          userId: actor.userId,
          reason: input.reason,
          note: sanitizeText(input.note),
        });
        if (r.openReportCount + 1 < threshold) return false;
        return this.changeStatus(
          tx,
          { ...r, openReportCount: r.openReportCount + 1 },
          {
            to: 'HIDDEN',
            action: 'auto_hide',
            reason: `Hidden automatically after ${String(threshold)} reports; awaiting moderation`,
            moderatorId: null,
            flags: [...new Set([...r.flags, 'REPORTS'])],
            closeReportsAs: null,
          },
          actor,
        );
      },
      () =>
        new ConflictError('You have already reported this review', {
          details: { reason: 'ALREADY_REPORTED' },
        }),
    );
    await this.afterChange(productId, changed);
    return { reportId };
  }

  // ── Shared mechanics (also used by ModerationService) ──

  /**
   * Status change of a LOCKED review: row update, report closing, audit, review_moderated event
   * and the summary delta. Returns true when the published rating changed.
   */
  async changeStatus(
    tx: Tx,
    r: ReviewRecord,
    change: StatusChange,
    actor: Actor,
  ): Promise<boolean> {
    const now = new Date();
    let openReportCount = r.openReportCount;
    if (change.closeReportsAs !== null) {
      await this.repo.closeReports(tx, r.id, change.closeReportsAs, {
        userId: change.moderatorId,
        note: change.reason,
      });
      openReportCount = 0;
    }
    await this.repo.update(
      tx,
      r.id,
      {
        status: change.to,
        moderationReason: change.reason,
        moderatedByUserId: change.moderatorId,
        moderatedAt: now,
        openReportCount,
        ...(change.flags === undefined ? {} : { flags: change.flags }),
        ...(change.to === 'PUBLISHED' && r.publishedAt === null ? { publishedAt: now } : {}),
      },
      r,
    );
    await this.deps.auditService.record(tx, actor, {
      action: `review.${change.action}`,
      targetType: 'review',
      targetId: r.id,
      before: { status: r.status },
      after: { status: change.to },
      reason: change.reason,
    });
    await emitProductEvent(
      tx,
      'product.review_moderated.v1',
      {
        reviewId: r.id,
        productId: r.productId,
        userId: r.userId,
        status: change.to,
        action: change.action,
        reason: change.reason,
      },
      actor.requestId,
    );
    return this.syncRating(
      tx,
      r.productId,
      contributionOf(r),
      contributionOf({ ...r, status: change.to }),
      actor.requestId,
    );
  }

  /**
   * Apply the published-rating delta: summary row (atomic upsert) → product columns → event.
   * No-op when nothing published changed.
   */
  async syncRating(
    tx: Tx,
    productId: string,
    before: Contribution | null,
    after: Contribution | null,
    correlationId: string,
  ): Promise<boolean> {
    const delta = summaryDelta(before, after);
    if (isZeroDelta(delta)) return false;
    const s = await this.repo.applySummaryDelta(tx, productId, delta);
    const ratingAvg = s.ratingCount > 0 ? s.ratingAvg.toFixed(2) : null;
    await this.deps.productsService.setRating(tx, productId, {
      ratingAvg,
      ratingCount: s.ratingCount,
    });
    await emitProductEvent(
      tx,
      'product.rating_changed.v1',
      { productId, ratingAvg, ratingCount: s.ratingCount, sequence: Date.now() },
      correlationId,
    );
    return true;
  }

  /** After commit: review pages + summary always; product cards only if the rating moved. */
  async afterChange(productId: string, ratingChanged: boolean): Promise<void> {
    if (productId === '') return;
    try {
      await this.deps.redis.incr(productKeys.reviewsVersion(productId));
      if (ratingChanged) await this.deps.redis.del(productKeys.ratingSummary(productId));
    } catch (err) {
      this.deps.logger.warn({ err }, 'review cache invalidation failed');
    }
    if (ratingChanged) await this.deps.productsService.invalidate([], productId);
  }

  /** One transaction; unique-index races map to a clean 409. */
  async write<T>(work: (tx: Tx) => Promise<T>, onUnique = () => alreadyReviewed()): Promise<T> {
    try {
      return await this.deps.runInTransaction(work);
    } catch (error) {
      if (isUniqueViolation(error)) throw onUnique();
      const mapped = mapPrismaError(error);
      throw mapped instanceof Error ? mapped : error;
    }
  }

  // ── Helpers ──

  /** Published + active product, by slug or id (in-process cache 60 s). */
  private async visibleProduct(slugOrId: string): Promise<ProductRef> {
    let ref = this.products.get(slugOrId);
    if (ref === undefined) {
      ref = await this.deps.productsService.reviewTarget(
        UUID.test(slugOrId) ? { id: slugOrId } : { slug: slugOrId },
      );
      this.products.set(slugOrId, ref);
    }
    if (ref?.reviewable !== true) throw new NotFoundError('Product');
    return ref;
  }

  private async listVersion(productId: string): Promise<string> {
    try {
      return (await this.deps.redis.get(productKeys.reviewsVersion(productId))) ?? '0';
    } catch {
      return 'nocache';
    }
  }

  /** Own, live review under a row lock; anyone else's → 404 (never reveals existence). */
  private async lockOwn(tx: Tx, id: string, userId: string): Promise<ReviewRecord> {
    const r = await this.repo.lock(tx, id);
    if (r?.userId !== userId) throw new NotFoundError('Review');
    return r;
  }

  private cleanContent(input: {
    title?: string | null;
    body?: string | null;
    images?: ReviewImage[];
  }): { title: string | null; body: string | null; images: ReviewImage[]; hasImages: boolean } {
    const title = sanitizeText(input.title)?.slice(0, REVIEW_LIMITS.titleMax) ?? null;
    const body = sanitizeText(input.body)?.slice(0, REVIEW_LIMITS.bodyMax) ?? null;
    const images = dedupeImages(input.images ?? []).slice(0, REVIEW_LIMITS.maxImages);
    const bad = images.findIndex(
      (img) => !isAllowedImageUrl(img.url, this.deps.config.MEDIA_PUBLIC_BASE_URL),
    );
    if (bad >= 0)
      throw new ValidationError([
        { path: `body.images.${String(bad)}.url`, message: 'Upload images through media-service' },
      ]);
    return { title, body, images, hasImages: images.length > 0 };
  }

  private async myView(id: string): Promise<MyReviewView> {
    const r = await this.repo.findLive(id);
    if (r === null) throw new NotFoundError('Review');
    const names = await this.deps.productsService.productNames([r.productId]);
    return toMyReview(r, names.get(r.productId) ?? null, this.deps.config.REVIEW_MAX_EDITS);
  }
}
