import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { SummaryDelta } from './reviews.rules.js';
import type {
  AdminReviewQuery,
  AnalyticsQuery,
  PublicReviewQuery,
  ReportListQuery,
  ReportReason,
  ReportStatus,
  ReviewImage,
  ReviewStatus,
} from './reviews.types.js';

// ── Selects ──

const PUBLIC_SELECT = {
  id: true,
  productId: true,
  variantId: true,
  authorName: true,
  rating: true,
  title: true,
  body: true,
  images: true,
  helpfulCount: true,
  editCount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductReviewSelect;

const FULL_SELECT = {
  ...PUBLIC_SELECT,
  orderId: true,
  userId: true,
  hasImages: true,
  status: true,
  flags: true,
  moderationReason: true,
  reportCount: true,
  openReportCount: true,
  publishedAt: true,
  moderatedByUserId: true,
  moderatedAt: true,
  version: true,
  deletedAt: true,
} satisfies Prisma.ProductReviewSelect;

const REPORT_SELECT = {
  id: true,
  reviewId: true,
  userId: true,
  reason: true,
  note: true,
  status: true,
  resolvedByUserId: true,
  resolvedAt: true,
  resolutionNote: true,
  createdAt: true,
} satisfies Prisma.ReviewReportSelect;

export type PublicReviewRecord = Prisma.ProductReviewGetPayload<{ select: typeof PUBLIC_SELECT }>;
export type ReviewRecord = Prisma.ProductReviewGetPayload<{ select: typeof FULL_SELECT }>;
export type ReportRecord = Prisma.ReviewReportGetPayload<{ select: typeof REPORT_SELECT }>;

export interface NewReview {
  id: string;
  productId: string;
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
}

export interface ReviewPatch {
  rating?: number;
  title?: string | null;
  body?: string | null;
  images?: ReviewImage[];
  status?: ReviewStatus;
  flags?: string[];
  moderationReason?: string | null;
  publishedAt?: Date;
  moderatedByUserId?: string | null;
  moderatedAt?: Date | null;
  editCount?: number;
  openReportCount?: number;
  authorName?: string;
}

export interface SummaryRow {
  ratingCount: number;
  ratingSum: number;
  ratingAvg: Prisma.Decimal;
  star1: number;
  star2: number;
  star3: number;
  star4: number;
  star5: number;
  textCount: number;
  imageCount: number;
}

const LIVE = { deletedAt: null } as const;

const searchTextOf = (r: { title: string | null; body: string | null; authorName: string }) =>
  [r.authorName, r.title, r.body]
    .filter((v) => v !== null && v !== '')
    .join(' ')
    .slice(0, 4000);

/** Only place that touches review_* / product_reviews / product_rating_summaries. */
export class ReviewsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── Eligibility (order.delivered.v1 projection) ──

  async addEligibility(
    tx: Tx,
    rows: {
      userId: string;
      productId: string;
      variantId: string;
      orderId: string;
      orderNo: string;
      deliveredAt: Date;
    }[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await tx.reviewEligibility.createMany({ data: rows, skipDuplicates: true });
    return res.count;
  }

  /** Open (unused) purchases of one product for one customer, newest delivery first. */
  openEligibility(userId: string, productId: string, client: Tx | Cradle['db'] = this.db) {
    return client.reviewEligibility.findMany({
      where: { userId, productId, reviewId: null },
      orderBy: { deliveredAt: 'desc' },
      select: { id: true, orderId: true, variantId: true, deliveredAt: true },
      take: 20,
    });
  }

  async linkEligibility(tx: Tx, eligibilityId: string, reviewId: string): Promise<boolean> {
    const res = await tx.reviewEligibility.updateMany({
      where: { id: eligibilityId, reviewId: null },
      data: { reviewId },
    });
    return res.count === 1;
  }

  async unlinkEligibility(tx: Tx, reviewId: string): Promise<void> {
    await tx.reviewEligibility.updateMany({ where: { reviewId }, data: { reviewId: null } });
  }

  /** Delivered, not yet reviewed purchases (one per product: the newest delivery). */
  pendingForUser(userId: string, deliveredAfter: Date, query: { cursor?: string; limit: number }) {
    return withPrismaErrors(async () => {
      const rows = await this.db.reviewEligibility.findMany({
        where: { userId, reviewId: null, deliveredAt: { gte: deliveredAfter } },
        orderBy: [{ deliveredAt: 'desc' }, { id: 'desc' }],
        distinct: ['productId'],
        select: {
          id: true,
          productId: true,
          variantId: true,
          orderId: true,
          orderNo: true,
          deliveredAt: true,
        },
        ...cursorArgs(query),
      });
      return toPage(rows, query.limit);
    });
  }

  // ── Reviews: writes ──

  async insert(tx: Tx, r: NewReview): Promise<void> {
    await tx.productReview.create({
      data: {
        ...r,
        images: r.images as unknown as Prisma.InputJsonValue,
        hasImages: r.images.length > 0,
        publishedAt: r.status === 'PUBLISHED' ? new Date() : null,
        searchText: searchTextOf(r),
      },
      select: { id: true },
    });
  }

  /** Row lock for a read-modify-write on one review (deleted rows are invisible). */
  async lock(tx: Tx, id: string): Promise<ReviewRecord | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "product_reviews" WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (locked.length === 0) return null;
    return tx.productReview.findUnique({ where: { id }, select: FULL_SELECT });
  }

  async update(tx: Tx, id: string, patch: ReviewPatch, current: ReviewRecord): Promise<void> {
    const title = patch.title === undefined ? current.title : patch.title;
    const body = patch.body === undefined ? current.body : patch.body;
    const authorName = patch.authorName ?? current.authorName;
    const { images, ...rest } = patch;
    await tx.productReview.update({
      where: { id },
      data: {
        ...rest,
        ...(images === undefined
          ? {}
          : {
              images: images as unknown as Prisma.InputJsonValue,
              hasImages: images.length > 0,
            }),
        searchText: searchTextOf({ title, body, authorName }),
        version: { increment: 1 },
      },
      select: { id: true },
    });
  }

  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.productReview.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
      select: { id: true },
    });
  }

  // ── Reviews: reads ──

  findLive(id: string) {
    return withPrismaErrors(() =>
      this.db.productReview.findFirst({ where: { id, ...LIVE }, select: FULL_SELECT }),
    );
  }

  findAny(id: string) {
    return withPrismaErrors(() =>
      this.db.productReview.findUnique({ where: { id }, select: FULL_SELECT }),
    );
  }

  /** Which of these products the customer has already reviewed (live reviews). */
  async reviewedProductIds(userId: string, productIds: readonly string[]): Promise<Set<string>> {
    if (productIds.length === 0) return new Set();
    const rows = await withPrismaErrors(() =>
      this.db.productReview.findMany({
        where: { userId, productId: { in: [...productIds] }, ...LIVE },
        select: { productId: true },
      }),
    );
    return new Set(rows.map((r) => r.productId));
  }

  liveReviewOf(userId: string, productId: string) {
    return withPrismaErrors(() =>
      this.db.productReview.findFirst({
        where: { userId, productId, ...LIVE },
        select: { id: true },
      }),
    );
  }

  /** Storefront page: PUBLISHED only, keyset on the sort columns + id (index-backed). */
  async publicPage(
    productId: string,
    q: PublicReviewQuery,
  ): Promise<Paginated<PublicReviewRecord>> {
    const orderBy: Prisma.ProductReviewOrderByWithRelationInput[] =
      q.sort === 'helpful'
        ? [{ helpfulCount: 'desc' }, { id: 'desc' }]
        : q.sort === 'rating_high'
          ? [{ rating: 'desc' }, { id: 'desc' }]
          : q.sort === 'rating_low'
            ? [{ rating: 'asc' }, { id: 'desc' }]
            : [{ createdAt: 'desc' }, { id: 'desc' }];
    const rows = await withPrismaErrors(() =>
      this.db.productReview.findMany({
        where: {
          productId,
          status: 'PUBLISHED',
          ...LIVE,
          ...(q.rating === undefined ? {} : { rating: q.rating }),
          ...(q.withImages === true ? { hasImages: true } : {}),
        },
        orderBy,
        select: PUBLIC_SELECT,
        ...cursorArgs(q),
      }),
    );
    return toPage(rows, q.limit);
  }

  async mine(userId: string, query: { cursor?: string; limit: number }) {
    const rows = await withPrismaErrors(() =>
      this.db.productReview.findMany({
        where: { userId, ...LIVE },
        orderBy: { id: 'desc' },
        select: FULL_SELECT,
        ...cursorArgs(query),
      }),
    );
    return toPage(rows, query.limit);
  }

  async adminPage(q: AdminReviewQuery): Promise<Paginated<ReviewRecord>> {
    const where: Prisma.ProductReviewWhereInput = { ...LIVE };
    if (q.status !== undefined) where.status = q.status;
    if (q.rating !== undefined) where.rating = q.rating;
    if (q.productId !== undefined) where.productId = q.productId;
    if (q.userId !== undefined) where.userId = q.userId;
    if (q.orderId !== undefined) where.orderId = q.orderId;
    if (q.hasImages !== undefined) where.hasImages = q.hasImages;
    if (q.flagged === true) where.NOT = { flags: { isEmpty: true } };
    if (q.flagged === false) where.flags = { isEmpty: true };
    if (q.hasOpenReports === true) where.openReportCount = { gt: 0 };
    if (q.hasOpenReports === false) where.openReportCount = 0;
    if (q.from !== undefined || q.to !== undefined)
      where.createdAt = {
        ...(q.from === undefined ? {} : { gte: q.from }),
        ...(q.to === undefined ? {} : { lte: q.to }),
      };
    if (q.q !== undefined) {
      const ids = await this.searchIds(q.q);
      where.id = { in: ids };
    }
    const orderBy: Prisma.ProductReviewOrderByWithRelationInput[] =
      q.sort === 'oldest'
        ? [{ id: 'asc' }]
        : q.sort === 'rating_high'
          ? [{ rating: 'desc' }, { id: 'desc' }]
          : q.sort === 'rating_low'
            ? [{ rating: 'asc' }, { id: 'desc' }]
            : q.sort === 'helpful'
              ? [{ helpfulCount: 'desc' }, { id: 'desc' }]
              : q.sort === 'most_reported'
                ? [{ openReportCount: 'desc' }, { reportCount: 'desc' }, { id: 'desc' }]
                : [{ id: 'desc' }];
    const rows = await withPrismaErrors(() =>
      this.db.productReview.findMany({ where, orderBy, select: FULL_SELECT, ...cursorArgs(q) }),
    );
    return toPage(rows, q.limit);
  }

  /** Full-text (title, body, author) via the GIN tsvector; prefix match on the last word. */
  private async searchIds(q: string): Promise<string[]> {
    const words = q
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .slice(0, 8);
    if (words.length === 0) return [];
    const tsq = words.map((w, i) => (i === words.length - 1 ? `${w}:*` : w)).join(' & ');
    const rows = await withPrismaErrors(
      () => this.db.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "product_reviews"
        WHERE "deletedAt" IS NULL AND "searchVector" @@ to_tsquery('simple', ${tsq})
        ORDER BY "id" DESC LIMIT 2000`,
    );
    return rows.map((r) => r.id);
  }

  // ── Votes ──

  /** true = a new vote was stored. */
  async addVote(tx: Tx, reviewId: string, userId: string): Promise<boolean> {
    const res = await tx.reviewVote.createMany({
      data: [{ reviewId, userId }],
      skipDuplicates: true,
    });
    if (res.count === 0) return false;
    await tx.productReview.update({
      where: { id: reviewId },
      data: { helpfulCount: { increment: 1 } },
      select: { id: true },
    });
    return true;
  }

  async removeVote(tx: Tx, reviewId: string, userId: string): Promise<boolean> {
    const res = await tx.reviewVote.deleteMany({ where: { reviewId, userId } });
    if (res.count === 0) return false;
    await tx.$executeRaw`
      UPDATE "product_reviews" SET "helpfulCount" = GREATEST("helpfulCount" - 1, 0)
      WHERE "id" = ${reviewId}::uuid`;
    return true;
  }

  async votedIds(userId: string, reviewIds: readonly string[]): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.reviewVote.findMany({
        where: { userId, reviewId: { in: [...reviewIds] } },
        select: { reviewId: true },
      }),
    );
    return rows.map((r) => r.reviewId);
  }

  // ── Reports ──

  async insertReport(
    tx: Tx,
    r: { id: string; reviewId: string; userId: string; reason: ReportReason; note: string | null },
  ): Promise<void> {
    await tx.reviewReport.create({ data: r, select: { id: true } });
    await tx.productReview.update({
      where: { id: r.reviewId },
      data: { reportCount: { increment: 1 }, openReportCount: { increment: 1 } },
      select: { id: true },
    });
  }

  lockReport(tx: Tx, id: string) {
    return tx.$queryRaw<{ id: string; reviewId: string; status: ReportStatus }[]>`
      SELECT "id", "reviewId", "status" FROM "review_reports" WHERE "id" = ${id}::uuid FOR UPDATE`;
  }

  /** Close open reports of a review (all, or one) → number closed. */
  async closeReports(
    tx: Tx,
    reviewId: string,
    outcome: 'UPHELD' | 'DISMISSED',
    by: { userId: string | null; note: string | null },
    onlyId?: string,
  ): Promise<number> {
    const res = await tx.reviewReport.updateMany({
      where: { reviewId, status: 'OPEN', ...(onlyId === undefined ? {} : { id: onlyId }) },
      data: {
        status: outcome,
        resolvedByUserId: by.userId,
        resolvedAt: new Date(),
        resolutionNote: by.note,
      },
    });
    return res.count;
  }

  reportsOf(reviewId: string) {
    return withPrismaErrors(() =>
      this.db.reviewReport.findMany({
        where: { reviewId },
        orderBy: { id: 'desc' },
        select: REPORT_SELECT,
        take: 100,
      }),
    );
  }

  findReport(id: string) {
    return withPrismaErrors(() =>
      this.db.reviewReport.findUnique({ where: { id }, select: REPORT_SELECT }),
    );
  }

  async reportPage(q: ReportListQuery): Promise<Paginated<ReportRecord>> {
    const rows = await withPrismaErrors(() =>
      this.db.reviewReport.findMany({
        where: {
          ...(q.status === undefined ? {} : { status: q.status }),
          ...(q.reason === undefined ? {} : { reason: q.reason }),
          ...(q.reviewId === undefined ? {} : { reviewId: q.reviewId }),
          review: { deletedAt: null },
        },
        orderBy: q.status === 'OPEN' ? { id: 'asc' } : { id: 'desc' },
        select: REPORT_SELECT,
        ...cursorArgs(q),
      }),
    );
    return toPage(rows, q.limit);
  }

  // ── Rating summary ──

  /** Atomic upsert of the running totals (row lock serialises writers); returns the new totals. */
  async applySummaryDelta(tx: Tx, productId: string, d: SummaryDelta): Promise<SummaryRow> {
    const [s1, s2, s3, s4, s5] = d.stars;
    const rows = await tx.$queryRaw<SummaryRow[]>`
      INSERT INTO "product_rating_summaries" AS s
        ("productId", "ratingCount", "ratingSum", "ratingAvg", "star1", "star2", "star3", "star4",
         "star5", "textCount", "imageCount", "updatedAt")
      VALUES (${productId}::uuid, ${d.count}, ${d.sum},
        CASE WHEN ${d.count}::int > 0 THEN round(${d.sum}::numeric / ${d.count}::int, 2) ELSE 0 END,
        ${s1}, ${s2}, ${s3}, ${s4}, ${s5}, ${d.text}, ${d.image}, now())
      ON CONFLICT ("productId") DO UPDATE SET
        "ratingCount" = s."ratingCount" + EXCLUDED."ratingCount",
        "ratingSum" = s."ratingSum" + EXCLUDED."ratingSum",
        "ratingAvg" = CASE WHEN s."ratingCount" + EXCLUDED."ratingCount" > 0
          THEN round((s."ratingSum" + EXCLUDED."ratingSum")::numeric
                     / (s."ratingCount" + EXCLUDED."ratingCount"), 2)
          ELSE 0 END,
        "star1" = s."star1" + EXCLUDED."star1",
        "star2" = s."star2" + EXCLUDED."star2",
        "star3" = s."star3" + EXCLUDED."star3",
        "star4" = s."star4" + EXCLUDED."star4",
        "star5" = s."star5" + EXCLUDED."star5",
        "textCount" = s."textCount" + EXCLUDED."textCount",
        "imageCount" = s."imageCount" + EXCLUDED."imageCount",
        "updatedAt" = now()
      RETURNING "ratingCount", "ratingSum", "ratingAvg", "star1", "star2", "star3", "star4",
        "star5", "textCount", "imageCount"`;
    const row = rows[0];
    if (row === undefined) throw new Error('rating summary upsert returned no row');
    return row;
  }

  summary(productId: string) {
    return withPrismaErrors(() =>
      this.db.productRatingSummary.findUnique({
        where: { productId },
        select: {
          ratingCount: true,
          ratingSum: true,
          ratingAvg: true,
          star1: true,
          star2: true,
          star3: true,
          star4: true,
          star5: true,
          textCount: true,
          imageCount: true,
        },
      }),
    );
  }

  async statusCounts(productId?: string): Promise<Record<ReviewStatus, number>> {
    const rows = await withPrismaErrors(() =>
      this.db.productReview.groupBy({
        by: ['status'],
        where: { ...LIVE, ...(productId === undefined ? {} : { productId }) },
        _count: { _all: true },
      }),
    );
    const out: Record<ReviewStatus, number> = { PENDING: 0, PUBLISHED: 0, REJECTED: 0, HIDDEN: 0 };
    for (const r of rows) out[r.status] = r._count._all;
    return out;
  }

  // ── Analytics ──

  async analytics(q: AnalyticsQuery) {
    const from = q.from ?? new Date(Date.now() - 30 * 86_400_000);
    const to = q.to ?? new Date();
    const product =
      q.productId === undefined ? Prisma.empty : Prisma.sql`AND "productId" = ${q.productId}::uuid`;
    return withPrismaErrors(async () => {
      const [byStatus, daily, ratings, queue, reports, top, bottom] = await Promise.all([
        this.db.$queryRaw<{ status: ReviewStatus; count: number }[]>`
          SELECT "status", count(*)::int AS count FROM "product_reviews"
          WHERE "deletedAt" IS NULL AND "createdAt" BETWEEN ${from} AND ${to} ${product}
          GROUP BY "status"`,
        this.db.$queryRaw<{ day: Date; count: number; avg: Prisma.Decimal | null }[]>`
          SELECT date_trunc('day', "createdAt") AS day, count(*)::int AS count,
                 round(avg("rating") FILTER (WHERE "status" = 'PUBLISHED'), 2) AS avg
          FROM "product_reviews"
          WHERE "deletedAt" IS NULL AND "createdAt" BETWEEN ${from} AND ${to} ${product}
          GROUP BY 1 ORDER BY 1`,
        this.db.$queryRaw<{ rating: number; count: number }[]>`
          SELECT "rating"::int AS rating, count(*)::int AS count FROM "product_reviews"
          WHERE "deletedAt" IS NULL AND "status" = 'PUBLISHED'
            AND "createdAt" BETWEEN ${from} AND ${to} ${product}
          GROUP BY 1`,
        this.db.$queryRaw<{ count: number; oldest: Date | null }[]>`
          SELECT count(*)::int AS count, min("createdAt") AS oldest FROM "product_reviews"
          WHERE "deletedAt" IS NULL AND "status" = 'PENDING' ${product}`,
        this.db.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM "review_reports" r
          JOIN "product_reviews" p ON p."id" = r."reviewId" AND p."deletedAt" IS NULL
          WHERE r."status" = 'OPEN' ${q.productId === undefined ? Prisma.empty : Prisma.sql`AND p."productId" = ${q.productId}::uuid`}`,
        this.db.$queryRaw<{ productId: string; ratingAvg: Prisma.Decimal; ratingCount: number }[]>`
          SELECT "productId", "ratingAvg", "ratingCount" FROM "product_rating_summaries"
          WHERE "ratingCount" >= 3 ORDER BY "ratingAvg" DESC, "ratingCount" DESC LIMIT 10`,
        this.db.$queryRaw<{ productId: string; ratingAvg: Prisma.Decimal; ratingCount: number }[]>`
          SELECT "productId", "ratingAvg", "ratingCount" FROM "product_rating_summaries"
          WHERE "ratingCount" >= 3 ORDER BY "ratingAvg" ASC, "ratingCount" DESC LIMIT 10`,
      ]);
      return {
        from,
        to,
        byStatus,
        daily,
        ratings,
        queue: queue[0],
        reports: reports[0],
        top,
        bottom,
      };
    });
  }
}
