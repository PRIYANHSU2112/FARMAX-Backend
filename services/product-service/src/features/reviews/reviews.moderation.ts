import { createHash } from 'node:crypto';

import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { productKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { Actor, AuditRecord } from '../audit/index.js';
import { reviewVersionConflict } from './reviews.service.js';
import { REVIEW_TRANSITIONS, nextReviewStatus } from './reviews.status.js';
import type {
  AdminReviewDetail,
  AdminReviewQuery,
  AdminReviewView,
  AnalyticsQuery,
  ModerationAction,
  RatingSummaryView,
  ReportListQuery,
  ReportView,
  ReviewStatus,
} from './reviews.types.js';
import { toAdminReview, toReport } from './reviews.views.js';

type Deps = Pick<
  Cradle,
  'reviewsRepository' | 'reviewsService' | 'productsService' | 'auditService' | 'cache'
>;

const ANALYTICS_TTL_SECONDS = 300;

export interface BulkResult {
  id: string;
  ok: boolean;
  status?: ReviewStatus;
  error?: { code: string; message: string };
}

const invalidTransition = (status: ReviewStatus, action: ModerationAction) =>
  new ConflictError(`Cannot ${action} a review that is ${status}`, {
    details: { reason: 'INVALID_TRANSITION', status, action },
  });

/** Admin console: queue, search, moderation (single + bulk), reported content, analytics. */
export class ModerationService {
  constructor(private readonly deps: Deps) {}

  private get repo() {
    return this.deps.reviewsRepository;
  }

  // ── Reads ──

  async list(q: AdminReviewQuery): Promise<Paginated<AdminReviewView>> {
    const page = await this.repo.adminPage(q);
    const names = await this.deps.productsService.productNames(page.items.map((r) => r.productId));
    return {
      ...page,
      items: page.items.map((r) => toAdminReview(r, names.get(r.productId) ?? null)),
    };
  }

  async detail(id: string): Promise<AdminReviewDetail> {
    const r = await this.repo.findAny(id);
    if (r === null) throw new NotFoundError('Review');
    const [names, reports] = await Promise.all([
      this.deps.productsService.productNames([r.productId]),
      this.repo.reportsOf(id),
    ]);
    return { ...toAdminReview(r, names.get(r.productId) ?? null), reports: reports.map(toReport) };
  }

  async history(
    id: string,
    q: { cursor?: string; limit: number },
  ): Promise<Paginated<AuditRecord>> {
    if ((await this.repo.findAny(id)) === null) throw new NotFoundError('Review');
    return this.deps.auditService.history('review', id, q);
  }

  // ── Moderation ──

  async moderate(
    id: string,
    action: ModerationAction,
    reason: string | null,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<AdminReviewView> {
    const t = REVIEW_TRANSITIONS[action];
    if (t.needsReason && (reason === null || reason.trim().length < 10))
      throw new ValidationError([
        { path: 'body.reason', message: `A reason (10–500 characters) is required to ${action}` },
      ]);
    const svc = this.deps.reviewsService;
    let productId = '';
    const changed = await svc.write(async (tx) => {
      const r = await this.repo.lock(tx, id);
      if (r === null) throw new NotFoundError('Review');
      if (ifMatch !== undefined && ifMatch !== r.version) throw reviewVersionConflict(r.version);
      const to = nextReviewStatus(r.status, action);
      if (to === null) throw invalidTransition(r.status, action);
      productId = r.productId;
      return svc.changeStatus(
        tx,
        r,
        {
          to,
          action,
          reason,
          moderatorId: actor.userId,
          ...(to === 'PUBLISHED' ? { flags: r.flags.filter((f) => f !== 'REPORTS') } : {}),
          closeReportsAs: t.closesReportsAs,
        },
        actor,
      );
    });
    await svc.afterChange(productId, changed);
    return this.detail(id);
  }

  /** Same action on ≤ 100 reviews; each one is its own transaction (one failure skips only it). */
  async bulk(
    ids: readonly string[],
    action: ModerationAction,
    reason: string | null,
    actor: Actor,
  ): Promise<BulkResult[]> {
    const results: BulkResult[] = [];
    for (const id of new Set(ids)) {
      try {
        const view = await this.moderate(id, action, reason, undefined, actor);
        results.push({ id, ok: true, status: view.status });
      } catch (error) {
        const e = error as { code?: string; message?: string; statusCode?: number };
        if (e.statusCode === undefined || e.statusCode >= 500) throw error;
        results.push({
          id,
          ok: false,
          error: { code: e.code ?? 'ERROR', message: e.message ?? 'Failed' },
        });
      }
    }
    return results;
  }

  // ── Reported content ──

  async reports(q: ReportListQuery): Promise<Paginated<ReportView>> {
    const page = await this.repo.reportPage(q);
    return { ...page, items: page.items.map(toReport) };
  }

  /**
   * UPHOLD → the review is hidden (all its open reports upheld).
   * DISMISS → this report closes; an auto-hidden review with no open reports left is restored.
   */
  async resolveReport(
    reportId: string,
    decision: 'UPHOLD' | 'DISMISS',
    note: string,
    actor: Actor,
  ): Promise<ReportView> {
    const svc = this.deps.reviewsService;
    let productId = '';
    const changed = await svc.write(async (tx) => {
      const [rep] = await this.repo.lockReport(tx, reportId);
      if (rep === undefined) throw new NotFoundError('Report');
      if (rep.status !== 'OPEN')
        throw new ConflictError('This report is already resolved', {
          details: { reason: 'REPORT_ALREADY_RESOLVED', status: rep.status },
        });
      await this.deps.auditService.record(tx, actor, {
        action: `review_report.${decision.toLowerCase()}`,
        targetType: 'review_report',
        targetId: reportId,
        after: { reviewId: rep.reviewId, decision },
        reason: note,
      });
      const r = await this.repo.lock(tx, rep.reviewId);
      if (r === null) {
        await this.repo.closeReports(
          tx,
          rep.reviewId,
          'DISMISSED',
          { userId: actor.userId, note },
          reportId,
        );
        return false;
      }
      productId = r.productId;
      const by = { userId: actor.userId, note };

      if (decision === 'UPHOLD') {
        if (r.status === 'PUBLISHED' || r.status === 'PENDING')
          return svc.changeStatus(
            tx,
            r,
            {
              to: 'HIDDEN',
              action: 'hide',
              reason: note,
              moderatorId: actor.userId,
              closeReportsAs: 'UPHELD',
            },
            actor,
          );
        await this.repo.closeReports(tx, r.id, 'UPHELD', by);
        await this.repo.update(tx, r.id, { openReportCount: 0 }, r);
        return false;
      }

      await this.repo.closeReports(tx, r.id, 'DISMISSED', by, reportId);
      const open = Math.max(r.openReportCount - 1, 0);
      const autoHidden = r.status === 'HIDDEN' && r.moderatedByUserId === null;
      if (autoHidden && open === 0)
        return svc.changeStatus(
          tx,
          { ...r, openReportCount: 0 },
          {
            to: 'PUBLISHED',
            action: 'restore',
            reason: null,
            moderatorId: actor.userId,
            flags: r.flags.filter((f) => f !== 'REPORTS'),
            closeReportsAs: null,
          },
          actor,
        );
      await this.repo.update(tx, r.id, { openReportCount: open }, r);
      return false;
    });
    await svc.afterChange(productId, changed);
    const report = await this.repo.findReport(reportId);
    if (report === null) throw new NotFoundError('Report');
    return toReport(report);
  }

  // ── Insights ──

  async productSummary(
    productId: string,
  ): Promise<{ summary: RatingSummaryView; byStatus: Record<ReviewStatus, number> }> {
    const [summary, byStatus] = await Promise.all([
      this.deps.reviewsService.buildSummary(productId),
      this.repo.statusCounts(productId),
    ]);
    return { summary, byStatus };
  }

  async analytics(q: AnalyticsQuery) {
    const hash = createHash('sha1')
      .update(JSON.stringify([q.from?.toISOString(), q.to?.toISOString(), q.productId]))
      .digest('base64url')
      .slice(0, 16);
    return this.deps.cache.getOrSet(productKeys.reviewAnalytics(hash), ANALYTICS_TTL_SECONDS, () =>
      this.buildAnalytics(q),
    );
  }

  private async buildAnalytics(q: AnalyticsQuery) {
    const a = await this.repo.analytics(q);
    const byStatus: Record<ReviewStatus, number> = {
      PENDING: 0,
      PUBLISHED: 0,
      REJECTED: 0,
      HIDDEN: 0,
    };
    for (const row of a.byStatus) byStatus[row.status] = row.count;
    const stars = [0, 0, 0, 0, 0];
    let sum = 0;
    let count = 0;
    for (const row of a.ratings) {
      stars[row.rating - 1] = row.count;
      sum += row.rating * row.count;
      count += row.count;
    }
    const names = await this.deps.productsService.productNames(
      [...a.top, ...a.bottom].map((p) => p.productId),
    );
    const rank = (rows: typeof a.top) =>
      rows.map((p) => ({
        productId: p.productId,
        product: names.get(p.productId) ?? null,
        ratingAvg: p.ratingAvg.toFixed(2),
        ratingCount: p.ratingCount,
      }));
    const oldest = a.queue?.oldest ?? null;
    return {
      from: a.from,
      to: a.to,
      totals: { ...byStatus, all: Object.values(byStatus).reduce((x, y) => x + y, 0) },
      published: {
        count,
        ratingAvg: count > 0 ? (Math.round((sum / count) * 100) / 100).toFixed(2) : null,
        distribution: ([5, 4, 3, 2, 1] as const).map((n) => ({
          stars: n,
          count: stars[n - 1] ?? 0,
        })),
      },
      daily: a.daily.map((d) => ({
        day: d.day.toISOString().slice(0, 10),
        count: d.count,
        ratingAvg: d.avg === null ? null : d.avg.toFixed(2),
      })),
      moderationQueue: {
        pending: a.queue?.count ?? 0,
        oldestPendingMinutes:
          oldest === null ? null : Math.floor((Date.now() - oldest.getTime()) / 60_000),
      },
      openReports: a.reports?.count ?? 0,
      topRated: rank(a.top),
      lowestRated: rank(a.bottom),
    };
  }
}
