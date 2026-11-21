import type { Paginated } from '@farmx/common/types';
import { cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

export interface CheckRow {
  id: string;
  checkType: string;
  refId: string;
  userId: string | null;
  expected: string | null;
  actual: string | null;
  status: string;
  detectedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
}

export interface Finding {
  checkType: string;
  refId: string;
  userId: string | null;
  expected: string;
  actual: string;
}

/** Only place that touches `wallet_ledger_checks`. */
export class ChecksRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** One row per (checkType, refId): (re)opened and refreshed while the finding is seen. */
  async upsert(f: Finding, now: Date): Promise<void> {
    await withPrismaErrors(() =>
      this.db.walletLedgerCheck.upsert({
        where: { checkType_refId: { checkType: f.checkType, refId: f.refId } },
        create: { ...f, detectedAt: now, lastSeenAt: now },
        update: {
          expected: f.expected,
          actual: f.actual,
          status: 'OPEN',
          lastSeenAt: now,
          resolvedAt: null,
        },
      }),
    );
  }

  /** OPEN findings not seen in this run are RESOLVED. */
  async resolveUnseen(before: Date): Promise<number> {
    const res = await withPrismaErrors(() =>
      this.db.walletLedgerCheck.updateMany({
        where: { status: 'OPEN', lastSeenAt: { lt: before } },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      }),
    );
    return res.count;
  }

  async list(q: { status?: string; cursor?: string; limit: number }): Promise<Paginated<CheckRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.walletLedgerCheck.findMany({
        where: q.status === undefined ? {} : { status: q.status },
        orderBy: { id: 'desc' },
        ...cursorArgs(q),
      }),
    );
    return toPage(rows, q.limit);
  }
}
