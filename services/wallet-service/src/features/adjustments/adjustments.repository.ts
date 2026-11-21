import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { AdjustmentListQuery, AdjustmentRow } from './adjustments.types.js';

/** Only place that touches `wallet_adjustments` (decided rows are final: DB trigger). */
export class AdjustmentsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  find(id: string): Promise<AdjustmentRow | null> {
    return withPrismaErrors(() => this.db.walletAdjustment.findUnique({ where: { id } }));
  }

  byKey(tx: Tx, requestedBy: string, idempotencyKey: string): Promise<AdjustmentRow | null> {
    return tx.walletAdjustment.findUnique({
      where: { requestedBy_idempotencyKey: { requestedBy, idempotencyKey } },
    });
  }

  insert(tx: Tx, data: Prisma.WalletAdjustmentUncheckedCreateInput): Promise<AdjustmentRow> {
    return tx.walletAdjustment.create({ data });
  }

  async lock(tx: Tx, id: string): Promise<AdjustmentRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "wallet_adjustments" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return tx.walletAdjustment.findUnique({ where: { id } });
  }

  update(
    tx: Tx,
    id: string,
    data: Prisma.WalletAdjustmentUncheckedUpdateInput,
  ): Promise<AdjustmentRow> {
    return tx.walletAdjustment.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  }

  async list(q: AdjustmentListQuery): Promise<Paginated<AdjustmentRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.walletAdjustment.findMany({
        where: {
          ...(q.status === undefined ? {} : { status: q.status }),
          ...(q.userId === undefined ? {} : { userId: q.userId }),
        },
        orderBy: { id: 'desc' },
        ...cursorArgs(q),
      }),
    );
    return toPage(rows, q.limit);
  }
}
