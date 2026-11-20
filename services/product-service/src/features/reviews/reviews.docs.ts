import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import {
  AUTH_ADMIN,
  AUTH_PUBLIC,
  IDEMPOTENCY_KEY,
  IDS,
  IF_MATCH,
  IF_NONE_MATCH,
  PUBLIC_ETAG,
  VERSION_ETAG,
  ok,
  reasonIssue,
} from '../../docs/shared.js';
import {
  MODERATION_ACTIONS,
  type ModerationAction,
  REPORT_REASONS,
  REVIEW_STATUSES,
} from './reviews.types.js';

export const REVIEWS_TAG = 'Catalog · Reviews';
export const MY_REVIEWS_TAG = 'Customer · Reviews';
export const ADMIN_REVIEWS_TAG = 'Admin · Reviews';

const VIEW = 'reviews.view';
const MODERATE = 'reviews.moderate';
const at = '2026-11-28T09:30:00.000Z';
const page = { nextCursor: null, limit: 20 };
const AUTH_CUSTOMER =
  'Bearer access token of a `CUSTOMER` with full scope. Own records only: another customer’s review id answers 404.';
const REVIEW = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9f01';
const REPORT = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9f51';
const ORDER = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9f81';
const CUSTOMER = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e41';

// ── Schemas ──

const image = Joi.object({
  mediaId: Joi.string().guid(),
  url: Joi.string().uri().example('https://cdn.farmx.in/reviews/0193a5f2.jpg'),
}).meta({ className: 'ReviewImage' });

const publicReviewFields = {
  id: Joi.string().guid(),
  productId: Joi.string().guid(),
  variantId: Joi.string().guid().description('Pack the customer bought'),
  authorName: Joi.string().example('Ramesh K.').description('Masked; never the full name'),
  rating: Joi.number().integer().min(1).max(5),
  title: Joi.string().allow(null),
  body: Joi.string().allow(null),
  images: Joi.array().items(image),
  isVerifiedPurchase: Joi.boolean().valid(true).description('Always true: delivery required'),
  helpfulCount: Joi.number().integer(),
  isEdited: Joi.boolean(),
  createdAt: Joi.date(),
  updatedAt: Joi.date(),
};
const publicReview = Joi.object(publicReviewFields).meta({ className: 'PublicReview' });

const productRef = Joi.object({ name: Joi.string(), slug: Joi.string() }).allow(null);
const status = Joi.string().valid(...REVIEW_STATUSES);

const myReview = Joi.object({
  ...publicReviewFields,
  status,
  orderId: Joi.string().guid(),
  moderationReason: Joi.string()
    .allow(null)
    .description('Why it was rejected / hidden (only then)'),
  product: productRef,
  editCount: Joi.number().integer(),
  canEdit: Joi.boolean(),
  version: Joi.number().integer().description('Send back as `If-Match` when editing'),
}).meta({ className: 'MyReview' });

const reportView = Joi.object({
  id: Joi.string().guid(),
  reviewId: Joi.string().guid(),
  userId: Joi.string().guid(),
  reason: Joi.string().valid(...REPORT_REASONS),
  note: Joi.string().allow(null),
  status: Joi.string().valid('OPEN', 'UPHELD', 'DISMISSED'),
  resolvedByUserId: Joi.string().guid().allow(null),
  resolvedAt: Joi.date().allow(null),
  resolutionNote: Joi.string().allow(null),
  createdAt: Joi.date(),
}).meta({ className: 'ReviewReport' });

const adminReviewFields = {
  id: Joi.string().guid(),
  productId: Joi.string().guid(),
  product: productRef,
  variantId: Joi.string().guid(),
  orderId: Joi.string().guid(),
  userId: Joi.string().guid(),
  authorName: Joi.string(),
  rating: Joi.number().integer(),
  title: Joi.string().allow(null),
  body: Joi.string().allow(null),
  images: Joi.array().items(image),
  status,
  flags: Joi.array()
    .items(Joi.string())
    .description(
      'Auto-moderation reasons: IMAGES, LINK, PHONE, EMAIL, BANNED_WORD, SHOUTING, REPEATED, REPORTS',
    ),
  moderationReason: Joi.string().allow(null),
  helpfulCount: Joi.number().integer(),
  reportCount: Joi.number().integer(),
  openReportCount: Joi.number().integer(),
  editCount: Joi.number().integer(),
  publishedAt: Joi.date().allow(null),
  moderatedByUserId: Joi.string()
    .guid()
    .allow(null)
    .description('null + HIDDEN = auto-hidden by reports'),
  moderatedAt: Joi.date().allow(null),
  version: Joi.number().integer(),
  createdAt: Joi.date(),
  updatedAt: Joi.date(),
  deletedAt: Joi.date().allow(null),
};
const adminReview = Joi.object(adminReviewFields).meta({ className: 'AdminReview' });
const adminReviewDetail = Joi.object({
  ...adminReviewFields,
  reports: Joi.array().items(reportView),
}).meta({ className: 'AdminReviewDetail' });

const summary = Joi.object({
  productId: Joi.string().guid(),
  ratingAvg: Joi.string().allow(null).example('4.35').description('null = no published ratings'),
  ratingCount: Joi.number().integer(),
  distribution: Joi.array().items(
    Joi.object({
      stars: Joi.number().integer().valid(5, 4, 3, 2, 1),
      count: Joi.number().integer(),
      percent: Joi.number().integer(),
    }),
  ),
  textCount: Joi.number().integer().description('Published reviews with a title or text'),
  imageCount: Joi.number().integer(),
}).meta({ className: 'RatingSummary' });

// ── Examples ──

const publicExample = {
  id: REVIEW,
  productId: IDS.product,
  variantId: IDS.variant,
  authorName: 'Ramesh K.',
  rating: 5,
  title: 'Cleared CRD in 4 days',
  body: 'Used 1 ml per litre for 5 days in a 5,000-bird broiler flock. Mortality dropped by day 3.',
  images: [],
  isVerifiedPurchase: true,
  helpfulCount: 12,
  isEdited: false,
  createdAt: at,
  updatedAt: at,
};
const myExample = {
  ...publicExample,
  status: 'PUBLISHED',
  orderId: ORDER,
  moderationReason: null,
  product: { name: 'Enrocin 10% Oral Solution', slug: 'enrocin-10-pct-oral-solution' },
  editCount: 0,
  canEdit: true,
  version: 0,
};
const adminExample = {
  ...publicExample,
  product: myExample.product,
  orderId: ORDER,
  userId: CUSTOMER,
  status: 'PENDING',
  flags: ['PHONE'],
  moderationReason: null,
  reportCount: 0,
  openReportCount: 0,
  editCount: 0,
  publishedAt: null,
  moderatedByUserId: null,
  moderatedAt: null,
  version: 0,
  deletedAt: null,
};
const summaryExample = {
  productId: IDS.product,
  ratingAvg: '4.35',
  ratingCount: 128,
  distribution: [
    { stars: 5, count: 80, percent: 63 },
    { stars: 4, count: 28, percent: 22 },
    { stars: 3, count: 10, percent: 8 },
    { stars: 2, count: 4, percent: 3 },
    { stars: 1, count: 6, percent: 5 },
  ],
  textCount: 74,
  imageCount: 9,
};
const reportExample = {
  id: REPORT,
  reviewId: REVIEW,
  userId: CUSTOMER,
  reason: 'SPAM',
  note: null,
  status: 'OPEN',
  resolvedByUserId: null,
  resolvedAt: null,
  resolutionNote: null,
  createdAt: at,
};
const notFound = { summary: 'Unknown, unpublished or someone else’s', message: 'Review not found' };
const versionConflict = {
  summary: 'Stale If-Match',
  message: 'The review was changed elsewhere; reload and retry',
  details: { reason: 'VERSION_CONFLICT', currentVersion: 2 },
};

const MODERATE_TEXT: Record<ModerationAction, { summary: string; description: string }> = {
  approve: {
    summary: 'Approve a pending review',
    description: 'PENDING → PUBLISHED. Counts towards the product rating from now on.',
  },
  reject: {
    summary: 'Reject a review',
    description:
      'PENDING / PUBLISHED / HIDDEN → REJECTED. **Reason required** (shown to the author). Open reports are upheld. The author may edit and resubmit (→ PENDING).',
  },
  hide: {
    summary: 'Hide (take down) a review',
    description:
      'PENDING / PUBLISHED → HIDDEN. **Reason required**. Open reports are upheld; removed from the rating.',
  },
  restore: {
    summary: 'Restore a hidden or rejected review',
    description:
      'HIDDEN / REJECTED → PUBLISHED. Open reports are dismissed; counts towards the rating again.',
  },
};

const moderateDocs = (action: ModerationAction): RouteDocs => ({
  tag: ADMIN_REVIEWS_TAG,
  operationId: `adminReview${action.charAt(0).toUpperCase()}${action.slice(1)}`,
  summary: MODERATE_TEXT[action].summary,
  description:
    MODERATE_TEXT[action].description +
    '\n\nOne transaction: status + rating summary delta + product rating + audit row + `product.review_moderated.v1` (author notification).',
  auth: AUTH_ADMIN,
  permission: MODERATE,
  headers: IF_MATCH,
  requestExample:
    action === 'reject' || action === 'hide'
      ? { reason: 'Contains a phone number and an off-platform offer' }
      : {},
  success: {
    status: 200,
    description: 'The review after the change',
    data: adminReviewDetail,
    example: ok({
      ...adminExample,
      status: action === 'reject' ? 'REJECTED' : action === 'hide' ? 'HIDDEN' : 'PUBLISHED',
      version: 1,
      reports: [],
    }),
    headers: VERSION_ETAG,
  },
  errors: [404, 409, 422],
  errorExamples: {
    409: [
      {
        summary: 'Not allowed from the current status',
        message: `Cannot ${action} a review that is REJECTED`,
        details: { reason: 'INVALID_TRANSITION', status: 'REJECTED', action },
      },
      versionConflict,
    ],
    422: reasonIssue,
  },
});

// ── Route docs ──

export const REVIEW_DOCS = {
  publicList: {
    tag: REVIEWS_TAG,
    operationId: 'listProductReviews',
    summary: 'Reviews of a product',
    description:
      'PUBLISHED reviews only, verified purchases. `sort`: `recent` (default), `helpful`, `rating_high`, `rating_low`. Filters: `rating` (exact stars), `withImages`. Keyset pagination (`cursor`).\n\nCached 120 s per page (helpful counts may lag); send `If-None-Match` → 304.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: '120 per IP per minute',
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'A page of reviews',
      data: publicReview,
      paginated: true,
      example: ok([publicExample], page),
      headers: PUBLIC_ETAG,
    },
    errors: [404, 422],
  },
  summary: {
    tag: REVIEWS_TAG,
    operationId: 'getProductRatingSummary',
    summary: 'Rating summary (average + 5★…1★ bars)',
    description:
      'Average, number of ratings, count and % per star, reviews with text / images. O(1) read of running totals; cached 10 min and refreshed on every change.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: '120 per IP per minute',
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Rating summary',
      data: summary,
      example: ok(summaryExample),
      headers: PUBLIC_ETAG,
    },
    errors: [404, 422],
  },
  create: {
    tag: MY_REVIEWS_TAG,
    operationId: 'createReview',
    summary: 'Rate / review a delivered product',
    description:
      'Only after **delivery** (`order.delivered.v1`) and within the review window (default 180 days). One live review per product per customer (edit it instead). `orderId` picks a specific delivered order (default: the latest).\n\n' +
      'Auto-moderation: a rating or clean text publishes at once; images, links, phone numbers, emails, banned words, ALL-CAPS or repeated characters → `PENDING` until an admin approves. Image URLs must be media-service uploads.',
    auth: AUTH_CUSTOMER,
    rateLimit: '10 per user per hour',
    headers: IDEMPOTENCY_KEY,
    requestExample: {
      rating: 5,
      title: 'Cleared CRD in 4 days',
      body: 'Used 1 ml per litre for 5 days in a 5,000-bird broiler flock.',
      images: [],
    },
    success: {
      status: 201,
      description: 'Created (PUBLISHED or PENDING)',
      data: myReview,
      example: ok(myExample),
      headers: VERSION_ETAG,
    },
    errors: [403, 404, 409, 422],
    errorExamples: {
      403: [
        {
          summary: 'Not purchased / not delivered',
          message: 'Only customers who received this product can review it',
          details: { reason: 'NOT_ELIGIBLE' },
        },
        {
          summary: 'Too long after delivery',
          message: 'Reviews are accepted up to 180 days after delivery',
          details: { reason: 'REVIEW_WINDOW_CLOSED' },
        },
      ],
      409: {
        summary: 'Duplicate',
        message: 'You have already reviewed this product; edit your review instead',
        details: { reason: 'ALREADY_REVIEWED', reviewId: REVIEW },
      },
    },
  },
  pending: {
    tag: MY_REVIEWS_TAG,
    operationId: 'listProductsToReview',
    summary: 'Delivered products waiting for my review',
    description:
      'One row per product (latest delivery) still inside the review window, with the last day to review (`reviewBy`).',
    auth: AUTH_CUSTOMER,
    success: {
      status: 200,
      description: 'Products to review',
      data: Joi.object({
        productId: Joi.string().guid(),
        variantId: Joi.string().guid(),
        orderId: Joi.string().guid(),
        orderNo: Joi.string().example('FX-2611-000123'),
        deliveredAt: Joi.date(),
        reviewBy: Joi.date(),
        product: productRef,
      }).meta({ className: 'PendingReview' }),
      paginated: true,
      example: ok(
        [
          {
            productId: IDS.product,
            variantId: IDS.variant,
            orderId: ORDER,
            orderNo: 'FX-2611-000123',
            deliveredAt: at,
            reviewBy: '2027-05-27T09:30:00.000Z',
            product: myExample.product,
          },
        ],
        page,
      ),
    },
    errors: [422],
  },
  mine: {
    tag: MY_REVIEWS_TAG,
    operationId: 'listMyReviews',
    summary: 'My reviews (every status)',
    description: 'Newest first, with status and the rejection / hide reason.',
    auth: AUTH_CUSTOMER,
    success: {
      status: 200,
      description: 'My reviews',
      data: myReview,
      paginated: true,
      example: ok([myExample], page),
    },
    errors: [422],
  },
  votes: {
    tag: MY_REVIEWS_TAG,
    operationId: 'myHelpfulVotes',
    summary: 'Which of these reviews I marked helpful',
    description:
      'Pass up to 100 `reviewIds` (repeat the parameter) to paint the “Helpful ✓” state.',
    auth: AUTH_CUSTOMER,
    success: {
      status: 200,
      description: 'Voted review ids',
      data: Joi.object({ helpfulReviewIds: Joi.array().items(Joi.string().guid()) }),
      example: ok({ helpfulReviewIds: [REVIEW] }),
    },
    errors: [422],
  },
  update: {
    tag: MY_REVIEWS_TAG,
    operationId: 'updateMyReview',
    summary: 'Edit my review',
    description:
      'Any of rating, title, body, images. Not while HIDDEN; at most 5 edits. Content is re-moderated: clean → PUBLISHED, flagged → PENDING; a REJECTED review goes back to PENDING. The product rating is adjusted in the same transaction.',
    auth: AUTH_CUSTOMER,
    rateLimit: '10 per user per hour',
    headers: IF_MATCH,
    requestExample: {
      rating: 4,
      body: 'Worked well; slightly bitter so birds drank less on day 1.',
    },
    success: {
      status: 200,
      description: 'Updated review',
      data: myReview,
      example: ok({ ...myExample, rating: 4, editCount: 1, version: 1 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: {
      404: notFound,
      409: [
        versionConflict,
        {
          summary: 'Edit limit',
          message: 'A review can be edited at most 5 times',
          details: { reason: 'EDIT_LIMIT' },
        },
        {
          summary: 'Hidden',
          message: 'This review is under moderation and cannot be edited now',
          details: { reason: 'REVIEW_NOT_EDITABLE', status: 'HIDDEN' },
        },
      ],
    },
  },
  remove: {
    tag: MY_REVIEWS_TAG,
    operationId: 'deleteMyReview',
    summary: 'Delete my review',
    description:
      'Soft delete; removed from the rating at once. The purchase becomes reviewable again.',
    auth: AUTH_CUSTOMER,
    rateLimit: '10 per user per hour',
    success: { status: 204, description: 'Deleted' },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },
  vote: {
    tag: MY_REVIEWS_TAG,
    operationId: 'markReviewHelpful',
    summary: 'Mark a review helpful',
    description: 'Idempotent (one vote per customer). Not on your own review.',
    auth: AUTH_CUSTOMER,
    rateLimit: '60 per user per minute',
    success: {
      status: 200,
      description: 'New helpful count',
      data: Joi.object({ helpfulCount: Joi.number().integer() }),
      example: ok({ helpfulCount: 13 }),
    },
    errors: [404, 422],
  },
  unvote: {
    tag: MY_REVIEWS_TAG,
    operationId: 'unmarkReviewHelpful',
    summary: 'Remove my helpful vote',
    description: 'Idempotent.',
    auth: AUTH_CUSTOMER,
    rateLimit: '60 per user per minute',
    success: {
      status: 200,
      description: 'New helpful count',
      data: Joi.object({ helpfulCount: Joi.number().integer() }),
      example: ok({ helpfulCount: 12 }),
    },
    errors: [404, 422],
  },
  report: {
    tag: MY_REVIEWS_TAG,
    operationId: 'reportReview',
    summary: 'Report a review',
    description:
      'Once per customer per review; not your own. `note` is required for `OTHER`. When open reports reach the threshold (default 3) the review is **auto-hidden** until an admin decides.',
    auth: AUTH_CUSTOMER,
    rateLimit: '20 per user per day',
    requestExample: { reason: 'SPAM', note: null },
    success: {
      status: 201,
      description: 'Report received',
      data: Joi.object({ reportId: Joi.string().guid() }),
      example: ok({ reportId: REPORT }),
    },
    errors: [404, 409, 422],
    errorExamples: {
      409: {
        summary: 'Already reported',
        message: 'You have already reported this review',
        details: { reason: 'ALREADY_REPORTED' },
      },
    },
  },

  // ── Admin ──

  adminList: {
    tag: ADMIN_REVIEWS_TAG,
    operationId: 'adminListReviews',
    summary: 'Search and filter reviews (moderation queue)',
    description:
      '`q`: full-text over title, text and author name. Filters: `status` (PENDING = queue), `rating`, `productId`, `userId`, `orderId`, `hasImages`, `flagged`, `hasOpenReports`, `from`/`to` (created). Sort: `newest` (default), `oldest`, `rating_high`, `rating_low`, `helpful`, `most_reported`.',
    auth: AUTH_ADMIN,
    permission: VIEW,
    success: {
      status: 200,
      description: 'A page of reviews',
      data: adminReview,
      paginated: true,
      example: ok([adminExample], page),
    },
    errors: [422],
  },
  adminDetail: {
    tag: ADMIN_REVIEWS_TAG,
    operationId: 'adminGetReview',
    summary: 'Review detail with its reports',
    description: 'Includes deleted reviews. `ETag` = version for `If-Match` on moderation.',
    auth: AUTH_ADMIN,
    permission: VIEW,
    success: {
      status: 200,
      description: 'Review',
      data: adminReviewDetail,
      example: ok({ ...adminExample, reports: [reportExample] }),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
  },
  history: {
    tag: ADMIN_REVIEWS_TAG,
    operationId: 'adminReviewHistory',
    summary: 'Audit history of a review',
    description:
      'create, edit, delete, approve, reject, hide, restore, auto_hide: who, when, reason. Newest first; append-only.',
    auth: AUTH_ADMIN,
    permission: VIEW,
    success: {
      status: 200,
      description: 'Audit rows',
      data: Joi.object({
        id: Joi.string().guid(),
        actorUserId: Joi.string().guid(),
        action: Joi.string().example('review.reject'),
        reason: Joi.string().allow(null),
        createdAt: Joi.date(),
      }).meta({ className: 'ReviewAuditRecord' }),
      paginated: true,
      example: ok(
        [
          {
            id: IDS.audit,
            actorUserId: IDS.admin,
            action: 'review.reject',
            reason: 'Contains a phone number',
            createdAt: at,
          },
        ],
        page,
      ),
    },
    errors: [404, 422],
  },
  moderate: moderateDocs,
  bulk: {
    tag: ADMIN_REVIEWS_TAG,
    operationId: 'adminBulkModerateReviews',
    summary: 'Bulk approve / reject / hide / restore',
    description: `Up to 100 ids, one \`action\` (${MODERATION_ACTIONS.join(', ')}). Each review is its own transaction: one failure (e.g. invalid transition) does not stop the others. Reason required for reject / hide.`,
    auth: AUTH_ADMIN,
    permission: MODERATE,
    requestExample: { ids: [REVIEW], action: 'approve', reason: null },
    success: {
      status: 200,
      description: 'Per-id result',
      data: Joi.object({
        succeeded: Joi.number().integer(),
        failed: Joi.number().integer(),
        results: Joi.array().items(
          Joi.object({
            id: Joi.string().guid(),
            ok: Joi.boolean(),
            status,
            error: Joi.object({ code: Joi.string(), message: Joi.string() }),
          }),
        ),
      }),
      example: ok({
        succeeded: 1,
        failed: 0,
        results: [{ id: REVIEW, ok: true, status: 'PUBLISHED' }],
      }),
    },
    errors: [422],
  },
  reports: {
    tag: ADMIN_REVIEWS_TAG,
    operationId: 'adminListReviewReports',
    summary: 'Reported content queue',
    description:
      'Customer reports; default `status=OPEN` (oldest first). Filter by `reason` or `reviewId`.',
    auth: AUTH_ADMIN,
    permission: VIEW,
    success: {
      status: 200,
      description: 'A page of reports',
      data: reportView,
      paginated: true,
      example: ok([reportExample], page),
    },
    errors: [422],
  },
  resolveReport: {
    tag: ADMIN_REVIEWS_TAG,
    operationId: 'adminResolveReviewReport',
    summary: 'Resolve a report (uphold / dismiss)',
    description:
      '`UPHOLD` → the review is hidden and all its open reports are upheld. `DISMISS` → this report closes; an auto-hidden review with no open reports left is restored. `note` (10–500) is audited.',
    auth: AUTH_ADMIN,
    permission: MODERATE,
    requestExample: { decision: 'DISMISS', note: 'Genuine experience; no policy breach' },
    success: {
      status: 200,
      description: 'The resolved report',
      data: reportView,
      example: ok({
        ...reportExample,
        status: 'DISMISSED',
        resolvedByUserId: IDS.admin,
        resolvedAt: at,
        resolutionNote: 'Genuine experience; no policy breach',
      }),
    },
    errors: [404, 409, 422],
    errorExamples: {
      409: {
        summary: 'Already resolved',
        message: 'This report is already resolved',
        details: { reason: 'REPORT_ALREADY_RESOLVED', status: 'UPHELD' },
      },
    },
  },
  productSummary: {
    tag: ADMIN_REVIEWS_TAG,
    operationId: 'adminProductReviewSummary',
    summary: 'Product-wise rating summary + counts by status',
    description: 'Published rating summary plus how many reviews are in each status.',
    auth: AUTH_ADMIN,
    permission: VIEW,
    success: {
      status: 200,
      description: 'Summary',
      data: Joi.object({
        summary,
        byStatus: Joi.object({
          PENDING: Joi.number().integer(),
          PUBLISHED: Joi.number().integer(),
          REJECTED: Joi.number().integer(),
          HIDDEN: Joi.number().integer(),
        }),
      }),
      example: ok({
        summary: summaryExample,
        byStatus: { PENDING: 3, PUBLISHED: 128, REJECTED: 2, HIDDEN: 1 },
      }),
    },
    errors: [422],
  },
  analytics: {
    tag: ADMIN_REVIEWS_TAG,
    operationId: 'adminReviewAnalytics',
    summary: 'Review analytics',
    description:
      'Within `from`–`to` (default last 30 days), optionally one `productId`: totals by status, published average + distribution, daily volume and average, moderation queue size and age, open reports, top / lowest rated products (≥ 3 ratings). Cached 5 min.',
    auth: AUTH_ADMIN,
    permission: VIEW,
    success: {
      status: 200,
      description: 'Analytics',
      example: ok({
        from: '2026-10-29T00:00:00.000Z',
        to: at,
        totals: { PENDING: 3, PUBLISHED: 412, REJECTED: 9, HIDDEN: 2, all: 426 },
        published: {
          count: 412,
          ratingAvg: '4.21',
          distribution: [
            { stars: 5, count: 230 },
            { stars: 4, count: 110 },
            { stars: 3, count: 40 },
            { stars: 2, count: 14 },
            { stars: 1, count: 18 },
          ],
        },
        daily: [{ day: '2026-11-27', count: 18, ratingAvg: '4.30' }],
        moderationQueue: { pending: 3, oldestPendingMinutes: 95 },
        openReports: 4,
        topRated: [
          {
            productId: IDS.product,
            product: myExample.product,
            ratingAvg: '4.80',
            ratingCount: 54,
          },
        ],
        lowestRated: [],
      }),
    },
    errors: [422],
  },
} satisfies Record<string, RouteDocs | ((action: ModerationAction) => RouteDocs)>;
