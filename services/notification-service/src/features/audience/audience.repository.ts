import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { OrderRef } from './audience.types.js';

/** Only place that touches `notification_order_projections`. */
export class AudienceRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** First write wins (order owner and number never change). */
  async insertOrder(tx: Tx, ref: OrderRef): Promise<void> {
    await withPrismaErrors(() =>
      tx.notificationOrderProjection.createMany({ data: [ref], skipDuplicates: true }),
    );
  }

  async findOrder(orderId: string, tx?: Tx): Promise<OrderRef | null> {
    const db = tx ?? this.db;
    return withPrismaErrors(() =>
      db.notificationOrderProjection.findUnique({
        where: { orderId },
        select: { orderId: true, orderNo: true, userId: true },
      }),
    );
  }
}
