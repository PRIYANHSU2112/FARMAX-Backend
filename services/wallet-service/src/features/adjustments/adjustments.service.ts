import { randomBytes } from 'node:crypto';

import { AppError, ErrorCode, ForbiddenError, NotFoundError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import type { Actor } from '../audit/index.js';
import { rupees } from '../ledger/index.js';
import {
  type AdjustmentListQuery,
  type AdjustmentView,
  CATEGORY_OF,
  type CreateAdjustmentInput,
  LABEL_OF,
  toAdjustmentView,
} from './adjustments.types.js';

type Deps = Pick<
  Cradle,
  | 'adjustmentsRepository'
  | 'runInTransaction'
  | 'ledgerService'
  | 'rewardsService'
  | 'settingsService'
  | 'auditService'
>;

const yymmdd = (d = new Date()) => d.toISOString().slice(2, 10).replaceAll('-', '');
const newAdjustmentNo = () => `ADJ-${yymmdd()}-${randomBytes(4).toString('hex').toUpperCase()}`;

const refuse = (status: 409 | 422, message: string, reason: string, extra: object = {}) =>
  new AppError(status === 409 ? ErrorCode.CONFLICT : ErrorCode.VALIDATION_ERROR, message, status, {
    details: { reason, ...extra },
  });

/**
 * Manual wallet / points adjustments (D-54): one staff member requests (wallet.adjust), ANOTHER
 * approves or rejects (wallet.approve) — segregation of duties in the service AND a DB CHECK.
 * Approval posts the ledger journal in the same transaction (key adj:<id>), so an adjustment is
 * posted at most once; a debit the customer cannot cover is refused and stays pending.
 */
export class AdjustmentsService {
  constructor(private readonly deps: Deps) {}

  async create(
    actor: Actor & { userId: string },
    idempotencyKey: string,
    hash: string,
    input: CreateAdjustmentInput,
  ): Promise<AdjustmentView> {
    const s = await this.deps.settingsService.current();
    const max = input.ledger === 'WALLET' ? s.adjustmentMaxPaise : s.adjustmentMaxPoints;
    if (input.amount > max)
      throw refuse(422, 'The adjustment is above the single-adjustment limit', 'ABOVE_LIMIT', {
        max,
      });
    return this.deps.runInTransaction(async (tx) => {
      const repo = this.deps.adjustmentsRepository;
      const earlier = await repo.byKey(tx, actor.userId, idempotencyKey);
      if (earlier !== null) {
        if (earlier.requestHash !== hash)
          throw refuse(
            422,
            'This Idempotency-Key was used for another adjustment',
            'IDEMPOTENCY_KEY_REUSED',
          );
        return toAdjustmentView(earlier);
      }
      const row = await repo.insert(tx, {
        id: uuidv7(),
        adjustmentNo: newAdjustmentNo(),
        userId: input.userId,
        ledger: input.ledger,
        direction: input.direction,
        amount: BigInt(input.amount),
        category: input.category,
        title: input.title,
        reason: input.reason,
        requestedBy: actor.userId,
        idempotencyKey,
        requestHash: hash,
      });
      await this.deps.auditService.record(tx, actor, {
        action: 'wallet.adjustment.request',
        targetType: 'adjustment',
        targetId: row.id,
        after: toAdjustmentView(row),
        reason: input.reason,
      });
      return toAdjustmentView(row);
    });
  }

  async approve(
    actor: Actor & { userId: string },
    id: string,
    decisionReason: string | null,
  ): Promise<AdjustmentView> {
    return this.deps.runInTransaction(async (tx) => {
      const repo = this.deps.adjustmentsRepository;
      const a = await repo.lock(tx, id);
      if (a === null) throw new NotFoundError('Adjustment');
      if (a.status !== 'PENDING_APPROVAL')
        throw refuse(409, `The adjustment is already ${a.status}`, 'ALREADY_DECIDED');
      if (a.requestedBy === actor.userId)
        throw new ForbiddenError(
          'An adjustment must be approved by someone other than its requester',
        );

      let journalId: string;
      if (a.ledger === 'WALLET') {
        const posted = await this.deps.ledgerService.post(tx, {
          idempotencyKey: `adj:${a.id}`,
          userId: a.userId,
          kind: a.direction === 'CREDIT' ? 'ADJUSTMENT_CREDIT' : 'ADJUSTMENT_DEBIT',
          category: CATEGORY_OF[a.category],
          direction: a.direction,
          amountPaise: a.amount,
          counterparty: 'ADJUSTMENT',
          title: a.title,
          subtitle: LABEL_OF[a.category],
          refType: 'ADJUSTMENT',
          refId: a.id,
          metadata: { adjustmentNo: a.adjustmentNo, requestedBy: a.requestedBy },
          createdBy: actor.userId,
          correlationId: `adj:${a.id}`,
        });
        journalId = posted.journal.id;
      } else {
        const posted = await this.deps.rewardsService.adjustInTx(tx, {
          adjustmentId: a.id,
          userId: a.userId,
          direction: a.direction,
          points: a.amount,
          title: a.title,
          subtitle: LABEL_OF[a.category],
          approvedBy: actor.userId,
        });
        journalId = posted.id;
      }
      const done = await repo.update(tx, a.id, {
        status: 'POSTED',
        decidedBy: actor.userId,
        decidedAt: new Date(),
        decisionReason,
        journalId,
      });
      await this.deps.auditService.record(tx, actor, {
        action: 'wallet.adjustment.approve',
        targetType: 'adjustment',
        targetId: a.id,
        before: { status: a.status },
        after: {
          status: done.status,
          journalId,
          amount: a.ledger === 'WALLET' ? rupees(a.amount) : `${a.amount.toString()} pts`,
        },
        reason: decisionReason,
      });
      return toAdjustmentView(done);
    });
  }

  async reject(
    actor: Actor & { userId: string },
    id: string,
    decisionReason: string,
  ): Promise<AdjustmentView> {
    return this.deps.runInTransaction(async (tx) => {
      const repo = this.deps.adjustmentsRepository;
      const a = await repo.lock(tx, id);
      if (a === null) throw new NotFoundError('Adjustment');
      if (a.status !== 'PENDING_APPROVAL')
        throw refuse(409, `The adjustment is already ${a.status}`, 'ALREADY_DECIDED');
      if (a.requestedBy === actor.userId)
        throw new ForbiddenError(
          'An adjustment must be decided by someone other than its requester',
        );
      const done = await repo.update(tx, a.id, {
        status: 'REJECTED',
        decidedBy: actor.userId,
        decidedAt: new Date(),
        decisionReason,
      });
      await this.deps.auditService.record(tx, actor, {
        action: 'wallet.adjustment.reject',
        targetType: 'adjustment',
        targetId: a.id,
        before: { status: a.status },
        after: { status: done.status },
        reason: decisionReason,
      });
      return toAdjustmentView(done);
    });
  }

  async get(id: string): Promise<AdjustmentView> {
    const a = await this.deps.adjustmentsRepository.find(id);
    if (a === null) throw new NotFoundError('Adjustment');
    return toAdjustmentView(a);
  }

  async list(q: AdjustmentListQuery): Promise<Paginated<AdjustmentView>> {
    const page = await this.deps.adjustmentsRepository.list(q);
    return { ...page, items: page.items.map(toAdjustmentView) };
  }
}
