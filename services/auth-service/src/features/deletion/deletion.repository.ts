import { type Tx, isUniqueViolation } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

export interface DeletionRequestView {
  id: string;
  status: 'PENDING' | 'CANCELLED' | 'COMPLETED';
  requestedAt: Date;
  scheduledFor: Date;
}

const VIEW = { id: true, status: true, requestedAt: true, scheduledFor: true } as const;

/** Only place that touches `account_deletion_requests`. */
export class DeletionRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  findPending(userId: string): Promise<DeletionRequestView | null> {
    return this.deps.db.accountDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
      select: VIEW,
    });
  }

  /** null when a PENDING request already exists (partial unique index: one per user). */
  async createPending(
    tx: Tx,
    userId: string,
    reason: string | null,
    scheduledFor: Date,
  ): Promise<DeletionRequestView | null> {
    try {
      return await tx.accountDeletionRequest.create({
        data: { userId, reason, scheduledFor },
        select: VIEW,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /** The user's PENDING request, row-locked for the rest of the transaction. */
  async lockPending(tx: Tx, userId: string): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "account_deletion_requests"
       WHERE "userId" = ${userId}::uuid AND "status" = 'PENDING' FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** Due PENDING requests, locked with SKIP LOCKED (replicas never purge the same user twice). */
  lockDue(tx: Tx, now: Date, limit: number): Promise<{ id: string; userId: string }[]> {
    return tx.$queryRaw<{ id: string; userId: string }[]>`
      SELECT "id", "userId" FROM "account_deletion_requests"
       WHERE "status" = 'PENDING' AND "scheduledFor" <= ${now}
       ORDER BY "scheduledFor" LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
  }

  async finish(tx: Tx, id: string, status: 'CANCELLED' | 'COMPLETED'): Promise<void> {
    const now = new Date();
    await tx.accountDeletionRequest.update({
      where: { id },
      data: status === 'CANCELLED' ? { status, cancelledAt: now } : { status, completedAt: now },
    });
  }
}
