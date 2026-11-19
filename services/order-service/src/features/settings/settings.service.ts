import { InternalError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';
import Joi from 'joi';

import type { Actor } from '../audit/index.js';

/** Business settings (rows of `order_settings`, seeded by migrations, edited by admins). */
export interface OrderSettings {
  /** Unpaid hold: the buyer must pay within this (reservation + payment expiry follow it). */
  paymentWindowMinutes: number;
  /** Extra time after the window for a late gateway confirmation before the order FAILS. */
  paymentGraceSeconds: number;
  /** Max distinct lines in one order. */
  maxOrderLines: number;
  /** A paid order waiting longer than this raises order.review_overdue.v1 (once). */
  adminReviewSlaHours: number;
  /** A paid order still unreviewed after this is auto-rejected + refunded (0 = never). */
  adminAutoRejectHours: number;
  /** Buyer cancellations within this many minutes of placing pay no fee. */
  freeCancelMinutes: number;
  /** Fee (% of the refund) for buyer cancellations after the free window. */
  cancellationFeePercent: number;
  /** Max orders in one bulk confirm. */
  maxBulkConfirm: number;
}

export type SettingsPatch = Partial<OrderSettings> & { reason: string };

export const SETTING_RULES: Record<keyof OrderSettings, Joi.Schema> = {
  paymentWindowMinutes: Joi.number().integer().min(5).max(55),
  paymentGraceSeconds: Joi.number().integer().min(30).max(300),
  maxOrderLines: Joi.number().integer().min(1).max(200),
  adminReviewSlaHours: Joi.number().integer().min(1).max(72),
  adminAutoRejectHours: Joi.number().integer().min(0).max(240),
  freeCancelMinutes: Joi.number().integer().min(0).max(1_440),
  cancellationFeePercent: Joi.number().min(0).max(25).precision(2),
  maxBulkConfirm: Joi.number().integer().min(1).max(200),
};
export const SETTING_KEYS = Object.keys(SETTING_RULES) as (keyof OrderSettings)[];

const CACHE_MS = 15_000;

/** A missing / invalid row fails loudly; every instance sees a change within 15 s. */
export class SettingsService {
  private cached: { at: number; value: OrderSettings } | undefined;

  constructor(
    private readonly deps: Pick<Cradle, 'settingsRepository' | 'runInTransaction' | 'auditService'>,
  ) {}

  async current(): Promise<OrderSettings> {
    const now = Date.now();
    if (this.cached !== undefined && now - this.cached.at < CACHE_MS) return this.cached.value;
    const byKey = new Map((await this.deps.settingsRepository.all()).map((r) => [r.key, r.value]));
    const value: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) {
      const checked = SETTING_RULES[key].validate(byKey.get(key), { presence: 'required' });
      if (checked.error !== undefined)
        throw new InternalError(`order setting "${key}" is missing or invalid`);
      value[key] = checked.value;
    }
    this.cached = { at: now, value: value as unknown as OrderSettings };
    return this.cached.value;
  }

  /** Changes only the given keys; audited with before / after. */
  async update(actor: Actor, patch: SettingsPatch): Promise<OrderSettings> {
    const { reason, ...changes } = patch;
    this.cached = undefined;
    const before = await this.current();
    const changed = SETTING_KEYS.filter((k) => changes[k] !== undefined && changes[k] !== before[k]);
    if (changed.length > 0)
      await this.deps.runInTransaction(async (tx) => {
        for (const key of changed)
          await this.deps.settingsRepository.set(tx, key, changes[key] ?? before[key], actor.userId);
        await this.deps.auditService.record(tx, actor, {
          action: 'order_settings.update',
          targetType: 'order_settings',
          targetId: 'orders',
          before: Object.fromEntries(changed.map((k) => [k, before[k]])),
          after: Object.fromEntries(changed.map((k) => [k, changes[k]])),
          reason,
        });
      });
    this.cached = undefined;
    return this.current();
  }
}
