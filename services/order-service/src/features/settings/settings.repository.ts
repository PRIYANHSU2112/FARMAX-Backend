import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

/** Only place that touches `order_settings`. */
export class SettingsRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  all(): Promise<{ key: string; value: unknown }[]> {
    return withPrismaErrors(() =>
      this.deps.db.orderSetting.findMany({ select: { key: true, value: true } }),
    );
  }

  async set(tx: Tx, key: string, value: number, userId: string): Promise<void> {
    await tx.orderSetting.upsert({
      where: { key },
      create: { key, value, updatedByUserId: userId },
      update: { value, updatedByUserId: userId },
    });
  }
}
