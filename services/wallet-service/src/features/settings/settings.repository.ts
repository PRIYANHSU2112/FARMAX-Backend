import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

/** Only place that touches `wallet_settings`. */
export class SettingsRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  /** Inside a transaction pass `tx`: a pool read there can deadlock a busy pool. */
  all(tx?: Tx): Promise<{ key: string; value: unknown }[]> {
    return withPrismaErrors(() =>
      (tx ?? this.deps.db).walletSetting.findMany({ select: { key: true, value: true } }),
    );
  }

  async get(tx: Tx, key: string): Promise<unknown> {
    const row = await tx.walletSetting.findUnique({ where: { key } });
    return row?.value;
  }

  async set(tx: Tx, key: string, value: unknown, actorUserId: string | null): Promise<void> {
    await tx.walletSetting.update({
      where: { key },
      data: { value: value as object, updatedByUserId: actorUserId },
    });
  }
}
