import { InternalError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';
import Joi from 'joi';

/** Business rules (rows of `wallet_settings`, seeded by the migration). Never balances. */
export interface WalletSettings {
  /** Smallest / largest single top-up. */
  topupMinPaise: number;
  topupMaxPaise: number;
  /** Top-ups started per customer per IST day (expired ones do not count). */
  topupDailyMaxPaise: number;
  /** A top-up may not take the balance above this. */
  maxBalancePaise: number;
  /** "+₹500 +₹700 …" chips of the Add Money screen. */
  topupPresetsPaise: number[];
  /** Payment window of a top-up. */
  topupWindowMinutes: number;
  /** "10% cashback on first wallet top-up via UPI. Max ₹50." — paid as reward points. */
  firstTopupCashback: { enabled: boolean; method: string; percentBps: number; maxPaise: number };
  /** Value of one reward point in paise (10 = ₹0.10, i.e. 10 points = ₹1). */
  pointValuePaise: number;
  /** Earn rate: one point per this many paise of net paid order value (1000 = 1 pt per ₹10). */
  pointsEarnPaisePerPoint: number;
  /** Earned points stay PENDING this long after delivery (returns / refunds window). */
  pointsHoldDays: number;
  /** Points expire this many months after they became available. */
  pointsExpiryMonths: number;
  /** Smallest conversion and its step ("Convert" button). */
  pointsMinConvert: number;
  pointsConvertStep: number;
  /** "Points expiring soon" notice this many days ahead. */
  pointsExpiryNoticeDays: number;
  /** Largest single manual adjustment (staff console). */
  adjustmentMaxPaise: number;
  adjustmentMaxPoints: number;
}

const PAISE = Joi.number().integer().min(1);

const RULES: Record<keyof WalletSettings, Joi.Schema> = {
  topupMinPaise: PAISE,
  topupMaxPaise: PAISE,
  topupDailyMaxPaise: PAISE,
  maxBalancePaise: PAISE,
  topupPresetsPaise: Joi.array().items(PAISE).min(1).max(12),
  topupWindowMinutes: Joi.number()
    .integer()
    .min(5)
    .max(24 * 60),
  firstTopupCashback: Joi.object({
    enabled: Joi.boolean().required(),
    method: Joi.string().valid('upi', 'netbanking', 'card').required(),
    percentBps: Joi.number().integer().min(0).max(10_000).required(),
    maxPaise: Joi.number().integer().min(0).required(),
  }),
  pointValuePaise: Joi.number().integer().min(1).max(10_000),
  pointsEarnPaisePerPoint: Joi.number().integer().min(1).max(10_000_000),
  pointsHoldDays: Joi.number().integer().min(0).max(90),
  pointsExpiryMonths: Joi.number().integer().min(1).max(60),
  pointsMinConvert: Joi.number().integer().min(1),
  pointsConvertStep: Joi.number().integer().min(1),
  pointsExpiryNoticeDays: Joi.number().integer().min(1).max(90),
  adjustmentMaxPaise: PAISE,
  adjustmentMaxPoints: Joi.number().integer().min(1),
};

const CACHE_MS = 15_000;

/** Validated on read; a broken row fails loudly instead of moving money on a wrong rule. */
export class SettingsService {
  private cached: { at: number; value: WalletSettings } | undefined;

  constructor(private readonly deps: Pick<Cradle, 'settingsRepository'>) {}

  static readonly KEYS = Object.keys(RULES) as (keyof WalletSettings)[];

  /**
   * The rules (15 s memo). Inside a transaction ALWAYS pass `tx`: a cache miss would otherwise
   * take a second pool connection while this one is held (pool deadlock under load).
   */
  async current(tx?: Tx): Promise<WalletSettings> {
    const now = Date.now();
    if (this.cached !== undefined && now - this.cached.at < CACHE_MS) return this.cached.value;
    const rows = await this.deps.settingsRepository.all(tx);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const value = {} as Record<string, unknown>;
    for (const [key, rule] of Object.entries(RULES)) {
      const checked = rule.validate(byKey.get(key), { presence: 'required' });
      if (checked.error !== undefined)
        throw new InternalError(`wallet setting "${key}" is missing or invalid`);
      value[key] = checked.value;
    }
    const settings = value as unknown as WalletSettings;
    if (settings.topupMinPaise > settings.topupMaxPaise)
      throw new InternalError('wallet settings: topupMinPaise > topupMaxPaise');
    this.cached = { at: now, value: settings };
    return settings;
  }

  /** Drop the memo (call AFTER the change committed, or a concurrent read re-caches the old value). */
  invalidate(): void {
    this.cached = undefined;
  }

  /**
   * Staff change of one rule (validated like a read, plus cross-field checks) inside the caller's
   * audited transaction. Other replicas pick it up within the 15 s cache window.
   */
  async setInTx(
    tx: Tx,
    key: string,
    value: unknown,
    actorUserId: string,
  ): Promise<{ before: unknown; after: unknown }> {
    const rule = (RULES as Record<string, Joi.Schema | undefined>)[key];
    if (rule === undefined) throw new NotFoundError('Setting');
    const checked = rule.validate(value, { presence: 'required' });
    if (checked.error !== undefined)
      throw new ValidationError([{ path: 'body.value', message: checked.error.message }]);
    const current = await this.current(tx);
    const next: WalletSettings = { ...current };
    (next as unknown as Record<string, unknown>)[key] = checked.value as unknown;
    if (next.topupMinPaise > next.topupMaxPaise)
      throw new ValidationError([
        { path: 'body.value', message: 'topupMinPaise must not exceed topupMaxPaise' },
      ]);
    if (next.topupMaxPaise > next.topupDailyMaxPaise)
      throw new ValidationError([
        { path: 'body.value', message: 'topupMaxPaise must not exceed topupDailyMaxPaise' },
      ]);
    if (next.pointsMinConvert % next.pointsConvertStep !== 0)
      throw new ValidationError([
        { path: 'body.value', message: 'pointsMinConvert must be a multiple of pointsConvertStep' },
      ]);
    const before = await this.deps.settingsRepository.get(tx, key);
    await this.deps.settingsRepository.set(tx, key, checked.value, actorUserId);
    return { before, after: checked.value as unknown };
  }
}
