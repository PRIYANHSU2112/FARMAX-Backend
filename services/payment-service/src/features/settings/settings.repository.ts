import { withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

/** Only place that touches `payment_settings`. */
export class SettingsRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  all(): Promise<{ key: string; value: unknown }[]> {
    return withPrismaErrors(() =>
      this.deps.db.paymentSetting.findMany({ select: { key: true, value: true } }),
    );
  }
}
