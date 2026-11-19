import { InternalError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';
import Joi from 'joi';

/** Business settings (rows of `payment_settings`, seeded by the migration). */
export interface PaymentSettings {
  /** Manual (non-system) refunds above this need `refunds.approve` by a second person. */
  refundManualApprovalAbovePaise: number;
  /** Gateway refund attempts before FAILED_FINAL. */
  refundMaxAttempts: number;
  /** Shown to the buyer: "refund expected by" (normal speed is 5–7 working days). */
  refundExpectedDays: number;
  /** An open payment older than this is re-checked with the gateway (lost webhook guard). */
  reconcileAfterSeconds: number;
}

const RULES: Record<keyof PaymentSettings, Joi.Schema> = {
  refundManualApprovalAbovePaise: Joi.number().integer().min(0),
  refundMaxAttempts: Joi.number().integer().min(1).max(20),
  refundExpectedDays: Joi.number().integer().min(1).max(30),
  reconcileAfterSeconds: Joi.number().integer().min(30).max(3_600),
};

const CACHE_MS = 15_000;

/** Read-only in P2 (change rows in the DB; an admin API comes with order settings in P4). */
export class SettingsService {
  private cached: { at: number; value: PaymentSettings } | undefined;

  constructor(private readonly deps: Pick<Cradle, 'settingsRepository'>) {}

  async current(): Promise<PaymentSettings> {
    const now = Date.now();
    if (this.cached !== undefined && now - this.cached.at < CACHE_MS) return this.cached.value;
    const rows = await this.deps.settingsRepository.all();
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const value = {} as Record<string, unknown>;
    for (const [key, rule] of Object.entries(RULES)) {
      const checked = rule.validate(byKey.get(key), { presence: 'required' });
      if (checked.error !== undefined)
        throw new InternalError(`payment setting "${key}" is missing or invalid`);
      value[key] = checked.value;
    }
    this.cached = { at: now, value: value as unknown as PaymentSettings };
    return this.cached.value;
  }
}
