import { ConflictError, ForbiddenError, NotFoundError } from '@farmx/common/errors';
import { describe, expect, it, vi } from 'vitest';

import { ModerationService } from '../../src/features/reviews/reviews.moderation.js';
import { ReviewsService } from '../../src/features/reviews/reviews.service.js';

const P = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8a01';
const R = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9f01';
const customer = { userId: 'u-cust', ip: '127.0.0.1', requestId: 'req-1' };
const other = { userId: 'u-other', ip: '127.0.0.1', requestId: 'req-2' };
const staff = { userId: 'u-admin', ip: '127.0.0.1', requestId: 'req-3' };
const D = (v: string) => ({ toFixed: () => v, toString: () => v });
const day = 86_400_000;

const review = (over: Record<string, unknown> = {}) => ({
  id: R,
  productId: P,
  variantId: 'v1',
  orderId: 'o1',
  userId: customer.userId,
  authorName: 'Ramesh K.',
  rating: 4,
  title: null,
  body: 'Good',
  images: [],
  hasImages: false,
  status: 'PUBLISHED',
  flags: [],
  moderationReason: null,
  helpfulCount: 0,
  reportCount: 0,
  openReportCount: 0,
  editCount: 0,
  publishedAt: new Date(),
  moderatedByUserId: null,
  moderatedAt: null,
  version: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  ...over,
});

const setup = (opts: { eligibility?: unknown[]; existing?: unknown; locked?: unknown } = {}) => {
  const tx = { outboxEvent: { create: vi.fn(() => Promise.resolve()) } };
  const repo = {
    liveReviewOf: vi.fn(() => Promise.resolve(opts.existing ?? null)),
    openEligibility: vi.fn(() =>
      Promise.resolve(
        opts.eligibility ?? [
          { id: 'e1', orderId: 'o1', variantId: 'v1', deliveredAt: new Date(Date.now() - day) },
        ],
      ),
    ),
    insert: vi.fn(() => Promise.resolve()),
    linkEligibility: vi.fn(() => Promise.resolve(true)),
    unlinkEligibility: vi.fn(() => Promise.resolve()),
    lock: vi.fn(() => Promise.resolve(opts.locked === undefined ? review() : opts.locked)),
    update: vi.fn(() => Promise.resolve()),
    softDelete: vi.fn(() => Promise.resolve()),
    closeReports: vi.fn(() => Promise.resolve(0)),
    insertReport: vi.fn(() => Promise.resolve()),
    addVote: vi.fn(() => Promise.resolve(true)),
    removeVote: vi.fn(() => Promise.resolve(true)),
    findLive: vi.fn(() => Promise.resolve(review())),
    findAny: vi.fn(() => Promise.resolve(review())),
    reportsOf: vi.fn(() => Promise.resolve([])),
    applySummaryDelta: vi.fn(() =>
      Promise.resolve({ ratingCount: 1, ratingSum: 4, ratingAvg: D('4.00') }),
    ),
  };
  const products = {
    reviewTarget: vi.fn(() =>
      Promise.resolve({ id: P, name: 'Enrocin', slug: 'enrocin', reviewable: true }),
    ),
    productNames: vi.fn(() => Promise.resolve(new Map())),
    setRating: vi.fn(() => Promise.resolve()),
    invalidate: vi.fn(() => Promise.resolve()),
  };
  const audit = { record: vi.fn(() => Promise.resolve()), history: vi.fn() };
  const redis = {
    incr: vi.fn(() => Promise.resolve(1)),
    del: vi.fn(() => Promise.resolve(1)),
    get: vi.fn(() => Promise.resolve(null)),
  };
  const config = {
    REVIEW_WINDOW_DAYS: 180,
    REVIEW_MAX_EDITS: 5,
    REVIEW_AUTO_HIDE_REPORTS: 3,
    REVIEW_BANNED_WORDS: 'whatsapp',
    MEDIA_PUBLIC_BASE_URL: 'https://cdn.farmx.in',
  };
  const deps = {
    reviewsRepository: repo,
    productsService: products,
    auditService: audit,
    userDirectoryClient: { maskedName: vi.fn(() => Promise.resolve('Ramesh K.')) },
    runInTransaction: (work: (t: unknown) => Promise<unknown>) => work(tx),
    redis,
    cache: { getOrSet: (_k: string, _t: number, fn: () => Promise<unknown>) => fn() },
    config,
    logger: { warn: vi.fn(), debug: vi.fn() },
  };
  const service = new ReviewsService(deps as never);
  const moderation = new ModerationService({ ...deps, reviewsService: service } as never);
  const events = () =>
    tx.outboxEvent.create.mock.calls.map(
      (c) => ((c as unknown[])[0] as { data: { type: string } }).data.type,
    );
  return { service, moderation, repo, products, audit, redis, tx, events };
};

describe('ReviewsService — create', () => {
  it('clean review publishes, links the purchase and updates the rating in one transaction', async () => {
    const { service, repo, products, events, redis } = setup();
    const view = await service.create(P, { rating: 4, body: 'Good' }, customer);

    expect(repo.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'PUBLISHED', flags: [], orderId: 'o1', rating: 4 }),
    );
    expect(repo.linkEligibility).toHaveBeenCalledWith(expect.anything(), 'e1', expect.any(String));
    expect(repo.applySummaryDelta).toHaveBeenCalledWith(expect.anything(), P, {
      count: 1,
      sum: 4,
      stars: [0, 0, 0, 1, 0],
      text: 1,
      image: 0,
    });
    expect(products.setRating).toHaveBeenCalledWith(expect.anything(), P, {
      ratingAvg: '4.00',
      ratingCount: 1,
    });
    expect(events()).toEqual(['product.rating_changed.v1']);
    expect(redis.incr).toHaveBeenCalled();
    expect(products.invalidate).toHaveBeenCalledWith([], P);
    expect(view.isVerifiedPurchase).toBe(true);
  });

  it('flagged review waits (PENDING) and does not touch the rating', async () => {
    const { service, repo, products } = setup();
    await service.create(P, { rating: 1, body: 'msg me on whatsapp 9876543210' }, customer);
    expect(repo.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'PENDING', flags: ['PHONE', 'BANNED_WORD'] }),
    );
    expect(repo.applySummaryDelta).not.toHaveBeenCalled();
    expect(products.setRating).not.toHaveBeenCalled();
  });

  it('not delivered → 403 NOT_ELIGIBLE', async () => {
    const { service } = setup({ eligibility: [] });
    await expect(service.create(P, { rating: 5 }, customer)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('delivered too long ago → 403 REVIEW_WINDOW_CLOSED', async () => {
    const { service } = setup({
      eligibility: [
        { id: 'e1', orderId: 'o1', variantId: 'v1', deliveredAt: new Date(Date.now() - 400 * day) },
      ],
    });
    await expect(service.create(P, { rating: 5 }, customer)).rejects.toMatchObject({
      details: { reason: 'REVIEW_WINDOW_CLOSED' },
    });
  });

  it('second review of the same product → 409 ALREADY_REVIEWED', async () => {
    const { service } = setup({ existing: { id: R } });
    await expect(service.create(P, { rating: 5 }, customer)).rejects.toMatchObject({
      details: { reason: 'ALREADY_REVIEWED', reviewId: R },
    });
  });

  it('unpublished product → 404', async () => {
    const { service, products } = setup();
    products.reviewTarget.mockResolvedValueOnce({
      id: P,
      name: 'x',
      slug: 'x',
      reviewable: false,
    });
    await expect(service.create('x-draft', { rating: 5 }, customer)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('images from outside media-service are refused (422)', async () => {
    const { service } = setup();
    await expect(
      service.create(
        P,
        { rating: 5, images: [{ mediaId: 'm1', url: 'https://evil.example/x.jpg' }] },
        customer,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('ReviewsService — edit / delete', () => {
  it('editing 4★ → 2★ moves the rating; someone else’s review → 404', async () => {
    const { service, repo } = setup();
    await service.update(R, { rating: 2 }, 0, customer);
    expect(repo.applySummaryDelta).toHaveBeenCalledWith(
      expect.anything(),
      P,
      expect.objectContaining({ count: 0, sum: -2, stars: [0, 1, 0, -1, 0] }),
    );
    await expect(service.update(R, { rating: 2 }, undefined, other)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('stale If-Match → 409; edit limit → 409; hidden → 409', async () => {
    await expect(setup().service.update(R, { rating: 2 }, 7, customer)).rejects.toMatchObject({
      details: { reason: 'VERSION_CONFLICT' },
    });
    await expect(
      setup({ locked: review({ editCount: 5 }) }).service.update(R, { rating: 2 }, 0, customer),
    ).rejects.toMatchObject({ details: { reason: 'EDIT_LIMIT' } });
    await expect(
      setup({ locked: review({ status: 'HIDDEN' }) }).service.update(R, { rating: 2 }, 0, customer),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('delete removes the published rating and frees the purchase', async () => {
    const { service, repo } = setup();
    await service.remove(R, customer);
    expect(repo.softDelete).toHaveBeenCalled();
    expect(repo.unlinkEligibility).toHaveBeenCalledWith(expect.anything(), R);
    expect(repo.applySummaryDelta).toHaveBeenCalledWith(
      expect.anything(),
      P,
      expect.objectContaining({ count: -1, sum: -4 }),
    );
  });
});

describe('ReviewsService — votes and reports', () => {
  it('cannot vote on or report your own review', async () => {
    const { service } = setup();
    await expect(service.vote(R, customer.userId, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.report(R, { reason: 'SPAM' }, customer)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('a report below the threshold only counts', async () => {
    const { service, repo } = setup();
    await service.report(R, { reason: 'SPAM' }, other);
    expect(repo.insertReport).toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('the 3rd open report auto-hides and removes it from the rating', async () => {
    const { service, repo, events } = setup({ locked: review({ openReportCount: 2 }) });
    await service.report(R, { reason: 'ABUSIVE' }, other);
    expect(repo.update).toHaveBeenCalledWith(
      expect.anything(),
      R,
      expect.objectContaining({ status: 'HIDDEN', moderatedByUserId: null, flags: ['REPORTS'] }),
      expect.anything(),
    );
    expect(events()).toEqual(['product.review_moderated.v1', 'product.rating_changed.v1']);
  });
});

describe('ModerationService', () => {
  it('approve publishes a pending review and adds it to the rating', async () => {
    const { moderation, repo, events, audit } = setup({ locked: review({ status: 'PENDING' }) });
    await moderation.moderate(R, 'approve', null, 0, staff);
    expect(repo.update).toHaveBeenCalledWith(
      expect.anything(),
      R,
      expect.objectContaining({ status: 'PUBLISHED', moderatedByUserId: staff.userId }),
      expect.anything(),
    );
    expect(repo.applySummaryDelta).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      staff,
      expect.objectContaining({ action: 'review.approve', targetType: 'review' }),
    );
    expect(events()).toContain('product.review_moderated.v1');
  });

  it('reject needs a reason; invalid transition → 409', async () => {
    const { moderation } = setup();
    await expect(moderation.moderate(R, 'reject', null, undefined, staff)).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(moderation.moderate(R, 'approve', null, undefined, staff)).rejects.toMatchObject({
      details: { reason: 'INVALID_TRANSITION' },
    });
  });

  it('bulk keeps going after one failure', async () => {
    const { moderation, repo } = setup({ locked: review({ status: 'PENDING' }) });
    repo.lock
      .mockResolvedValueOnce(review({ status: 'PENDING' }))
      .mockResolvedValueOnce(review({ status: 'PUBLISHED' }));
    const results = await moderation.bulk([R, 'r2'], 'approve', null, staff);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });
});
