import { ConflictError, ForbiddenError, NotFoundError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { FARM_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import type { DuplicateMatch, FarmStatus, FarmView } from '../farms/index.js';
import type {
  CaseStatus,
  CaseView,
  Decision,
  DecisionInput,
  OwnerClaim,
  QueueQuery,
  VerificationView,
} from './review.types.js';

type Deps = Pick<
  Cradle,
  'reviewRepository' | 'auditService' | 'outbox' | 'runInTransaction' | 'config' | 'accessClient'
> & {
  farmsService: Cradle['farmsService'];
  kycService: Cradle['kycService'];
};

const DECISION: Readonly<Record<Decision, { farm: FarmStatus; case: CaseStatus }>> = {
  APPROVE_SEPARATE: { farm: 'ACTIVE', case: 'RESOLVED_SEPARATE' },
  MERGE: { farm: 'MERGED', case: 'RESOLVED_MERGED' },
  REQUEST_CHANGES: { farm: 'NEEDS_ATTENTION', case: 'RESOLVED_CHANGES' },
  REJECT: { farm: 'REJECTED', case: 'RESOLVED_REJECTED' },
};

const LABEL: Readonly<Partial<Record<FarmStatus, VerificationView['statusLabel']>>> = {
  UNDER_REVIEW: 'Under Review',
  NEEDS_ATTENTION: 'Needs Attention',
  ACTIVE: 'Verified',
  DRAFT: 'Draft',
};

/** Duplicate-registration review: case lifecycle, owner claim, admin decisions (lazy deps: cycle with farms). */
export class ReviewService {
  constructor(private readonly deps: Deps) {}

  /** Called by farms.submit inside its transaction. */
  async openCase(
    tx: Tx,
    farm: FarmView,
    match: DuplicateMatch,
    requestId: string,
  ): Promise<CaseView> {
    const slaDueAt = new Date(Date.now() + this.deps.config.REVIEW_SLA_HOURS * 3_600_000);
    const created = await this.deps.reviewRepository.create(tx, {
      farmId: farm.id,
      matchedFarmId: match.candidate.farmId,
      matchedOwnerId: match.candidate.ownerId,
      sameOwner: match.candidate.sameOwner,
      signals: match.signals,
      score: match.score,
      distanceM: match.candidate.distanceM,
      nameSimilarity: Math.round(match.candidate.nameSimilarity * 1000) / 1000,
      slaDueAt,
    });
    await this.deps.outbox.add(
      tx,
      FARM_EVENTS.farmReviewRequired,
      {
        farmId: farm.id,
        caseId: created.id,
        signals: match.signals,
        slaDueAt: slaDueAt.toISOString(),
      },
      requestId,
    );
    return created;
  }

  /** Verification screen: status, timeline, the "separate unit?" question, document issues. */
  async verification(userId: string, farmId: string): Promise<VerificationView> {
    const farm = await this.deps.farmsService.getOwned(userId, farmId);
    const [found, issues] = await Promise.all([
      this.deps.reviewRepository.findLatestForFarm(farmId),
      this.deps.kycService.openIssues(farm.owner.id),
    ]);
    const open = found?.status === 'OPEN' ? found : null;
    // Another owner's farm is NEVER revealed (no data leak); same-owner matches are shown.
    let matched: { name: string; farmCode: string | null; distanceM: number | null } | null = null;
    if (open?.sameOwner === true) {
      const [m] = await this.deps.farmsService.internalBatch([open.matchedFarmId]);
      if (m !== undefined)
        matched = { name: m.name, farmCode: m.farmCode, distanceM: open.distanceM };
    }
    return {
      farmId,
      status: farm.status,
      statusLabel: LABEL[farm.status] ?? 'Closed',
      timeline: [
        { step: 1, label: 'Submitted', done: farm.submittedAt !== null, at: farm.submittedAt },
        {
          step: 2,
          label: 'Duplicate check',
          done: found !== null && found.status !== 'OPEN',
          at: found?.resolvedAt ?? null,
        },
        { step: 3, label: 'Farm ID issued', done: farm.farmCode !== null, at: farm.activatedAt },
      ],
      question:
        open === null
          ? null
          : {
              caseId: open.id,
              message: open.sameOwner
                ? 'You already have a farm registered nearby. Is this a separate unit?'
                : 'We found a registration with matching details. Our team will confirm shortly.',
              matchedFarm: matched,
              ownerClaim: open.ownerClaim,
            },
      issues,
    };
  }

  /**
   * Owner answers "Is this a separate unit?". SAME_FARM on a same-owner match merges at once
   * (nothing to verify); SEPARATE_UNIT stays in the human queue (it shares the loyalty tier).
   */
  async claim(actor: Actor, farmId: string, claim: OwnerClaim): Promise<VerificationView> {
    const farm = await this.deps.farmsService.getOwned(actor.userId, farmId);
    const open = await this.deps.reviewRepository.findLatestForFarm(farmId);
    if (open?.status !== 'OPEN')
      throw new ConflictError('There is no open question for this farm', {
        details: { reason: 'FARM_STATE_INVALID' },
      });
    const merged = await this.deps.runInTransaction(async (tx) => {
      await this.deps.reviewRepository.setClaim(tx, open.id, claim);
      if (claim !== 'SAME_FARM' || !open.sameOwner) return null;
      if (
        !(await this.deps.reviewRepository.resolve(
          tx,
          open.id,
          'RESOLVED_MERGED',
          null,
          'Owner confirmed it is the same farm',
        ))
      ) {
        throw new ConflictError('This case was already decided');
      }
      return this.deps.farmsService.transitionInTx(
        tx,
        farmId,
        'MERGED',
        actor,
        'OWNER',
        'Owner confirmed it is the same farm',
        {
          mergedIntoFarmId: open.matchedFarmId,
        },
      );
    });
    await this.deps.farmsService.invalidate(merged ?? farm);
    return this.verification(actor.userId, farmId);
  }

  // ── Admin ──

  /** Used by farm admin actions: a farm with an open case is decided only through the case. */
  async hasOpenCase(farmId: string): Promise<boolean> {
    return (await this.deps.reviewRepository.findLatestForFarm(farmId))?.status === 'OPEN';
  }

  queue(query: QueueQuery, reviewerId: string): Promise<Paginated<CaseView>> {
    return this.deps.reviewRepository.listQueue(query, reviewerId);
  }

  async getCase(caseId: string) {
    const found = await this.mustFind(caseId);
    const farms = await this.deps.farmsService.internalBatch([found.farmId, found.matchedFarmId]);
    return {
      ...found,
      farm: farms.find((f) => f.id === found.farmId) ?? null,
      matchedFarm: farms.find((f) => f.id === found.matchedFarmId) ?? null,
    };
  }

  async assign(actor: Actor, caseId: string, assigneeUserId: string): Promise<CaseView> {
    const before = await this.mustFind(caseId);
    if (before.status !== 'OPEN') throw new ConflictError('Case already resolved');
    return this.deps.runInTransaction(async (tx) => {
      const updated = await this.deps.reviewRepository.assign(tx, caseId, assigneeUserId);
      await this.deps.auditService.record(tx, actor, {
        action: 'review.assign',
        targetType: 'case',
        targetId: caseId,
        before: { assignedToUserId: before.assignedToUserId },
        after: { assignedToUserId: assigneeUserId },
      });
      return updated;
    });
  }

  /**
   * Admin decision. Segregation of duties: nobody decides on a farm they registered or own.
   * MERGE additionally needs `customers.merge`. Case + farm + audit + events: one transaction.
   */
  async decide(actor: Actor, caseId: string, input: DecisionInput): Promise<CaseView> {
    const found = await this.mustFind(caseId);
    if (found.status !== 'OPEN') throw new ConflictError('Case already resolved');
    const farm = await this.deps.farmsService.internalGet(found.farmId);
    if (farm.createdByUserId === actor.userId || farm.owner.userId === actor.userId) {
      throw new ForbiddenError('You cannot decide on a registration you created or own', {
        details: { reason: 'SOD_VIOLATION' },
      });
    }
    if (
      input.decision === 'MERGE' &&
      !(await this.deps.accessClient.hasPermission(actor.userId, 'customers.merge'))
    ) {
      throw new ForbiddenError();
    }
    const target = DECISION[input.decision];
    const { view, updated } = await this.deps.runInTransaction(async (tx) => {
      if (
        !(await this.deps.reviewRepository.resolve(
          tx,
          caseId,
          target.case,
          actor.userId,
          input.reason,
        ))
      ) {
        throw new ConflictError('Case already resolved');
      }
      const farmView = await this.deps.farmsService.transitionInTx(
        tx,
        found.farmId,
        target.farm,
        actor,
        'ADMIN',
        input.reason,
        {
          ...(input.decision === 'MERGE' ? { mergedIntoFarmId: found.matchedFarmId } : {}),
          issues: input.issues?.map(({ docType, code }) => ({ docType, code })),
        },
      );
      await this.deps.auditService.record(tx, actor, {
        action: `review.${input.decision.toLowerCase()}`,
        targetType: 'case',
        targetId: caseId,
        before: { status: found.status, farmStatus: farm.status },
        after: { status: target.case, farmStatus: target.farm, issues: input.issues ?? null },
        reason: input.reason,
      });
      return { view: farmView, updated: await this.deps.reviewRepository.findById(caseId, tx) };
    });
    await this.deps.farmsService.invalidate(view);
    if (updated === null) throw new NotFoundError('Case');
    return updated;
  }

  private async mustFind(caseId: string): Promise<CaseView> {
    const found = await this.deps.reviewRepository.findById(caseId);
    if (found === null) throw new NotFoundError('Case');
    return found;
  }
}
