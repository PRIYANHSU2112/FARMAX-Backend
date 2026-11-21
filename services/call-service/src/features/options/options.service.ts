import { createHash } from 'node:crypto';

import { AppError, ErrorCode, NotFoundError, ValidationError } from '@farmx/common/errors';
import { callKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import { type CallSettings, type SettingKey, checkSetting, parseSettings } from './options.settings.js';
import {
  type ConfigSnapshot,
  type CreateOptionInput,
  OPTION_TYPES,
  type OptionType,
  type OptionView,
  REQUIRED_TYPES,
  type SettingView,
  type UpdateOptionInput,
  type UpdateSettingInput,
} from './options.types.js';

/** Redis TTL of the snapshot; in-process memo on top of it (writes delete the Redis copy). */
const SNAPSHOT_TTL_SEC = 600;
const MEMO_MS = 5_000;

type Deps = Pick<Cradle, 'optionsRepository' | 'runInTransaction' | 'auditService' | 'cache' | 'gens' | 'logger'>;

/**
 * Chips and rules of the booking flow (D-53). Everything a screen lists is a `call_options` row and
 * every rule number is a `call_settings` row, so product can change them without a deploy.
 */
export class OptionsService {
  private memo: { at: number; value: ConfigSnapshot } | undefined;

  constructor(private readonly deps: Deps) {}

  /** Active options per type + typed settings. Cached in Redis (10 min) + memo (5 s). */
  async snapshot(): Promise<ConfigSnapshot> {
    const now = Date.now();
    if (this.memo !== undefined && now - this.memo.at < MEMO_MS) return this.memo.value;
    const cached = await this.deps.cache.getOrSet(callKeys.config(), SNAPSHOT_TTL_SEC, () => this.load());
    // Dates come back from Redis as strings; consumers only read code/label/meta/order.
    this.memo = { at: now, value: cached };
    return cached;
  }

  async settings(): Promise<CallSettings> {
    return (await this.snapshot()).settings;
  }

  /** Active codes of one type (e.g. valid LANGUAGE codes). */
  async activeCodes(type: OptionType): Promise<Set<string>> {
    return new Set((await this.snapshot()).options[type].map((o) => o.code));
  }

  // ── admin: options ──

  list(type?: OptionType): Promise<OptionView[]> {
    return this.deps.optionsRepository.list({ ...(type === undefined ? {} : { type }) });
  }

  async create(actor: Actor, input: CreateOptionInput): Promise<OptionView> {
    if (input.type === 'CHANNEL')
      throw new ValidationError(
        [{ path: 'type', message: 'Channels are fixed by the booking engine (VIDEO, PHONE, FARM_VISIT); edit their label or turn them off instead' }],
        'Channels cannot be created',
      );
    const created = await this.deps.runInTransaction(async (tx) => {
      const row = await this.deps.optionsRepository.create(tx, input);
      await this.deps.auditService.record(tx, actor, {
        action: 'option.create',
        targetType: 'option',
        targetId: row.id,
        after: { type: row.type, code: row.code, label: row.label },
      });
      return row;
    });
    await this.invalidate(false);
    return created;
  }

  async update(actor: Actor, id: string, input: UpdateOptionInput): Promise<OptionView> {
    const { reason, ...patch } = input;
    const result = await this.deps.runInTransaction(async (tx) => {
      const before = await this.deps.optionsRepository.findForUpdate(tx, id);
      if (before === null) throw new NotFoundError('Option');
      if (patch.isActive === false && before.isActive && REQUIRED_TYPES.has(before.type)) {
        const active = await this.deps.optionsRepository.countActiveLocked(tx, before.type);
        if (active <= 1)
          throw new AppError(
            ErrorCode.CONFLICT,
            `At least one ${before.type} option must stay active`,
            409,
            { details: { reason: 'LAST_ACTIVE_OPTION' } },
          );
      }
      const after = await this.deps.optionsRepository.update(tx, id, patch);
      await this.deps.auditService.record(tx, actor, {
        action: 'option.update',
        targetType: 'option',
        targetId: id,
        before: pick(before, patch),
        after: pick(after, patch),
        reason: reason ?? null,
      });
      return after;
    });
    // A channel turned on / off changes which slots exist.
    await this.invalidate(result.type === 'CHANNEL' && patch.isActive !== undefined);
    return result;
  }

  // ── admin: settings ──

  async listSettings(): Promise<SettingView[]> {
    const rows = await this.deps.optionsRepository.allSettings();
    return rows.map((r) => ({ ...r, key: r.key as SettingKey }));
  }

  async updateSetting(actor: Actor, key: SettingKey, input: UpdateSettingInput): Promise<SettingView> {
    const { value, issues } = checkSetting(key, input.value);
    if (issues.length > 0) throw new ValidationError(issues);
    const updatedAt = await this.deps.runInTransaction(async (tx) => {
      const before = await this.deps.optionsRepository.settingForUpdate(tx, key);
      const at = await this.deps.optionsRepository.upsertSetting(tx, key, value, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'setting.update',
        targetType: 'setting',
        targetId: key,
        before: before === null ? null : { value: before.value },
        after: { value },
        reason: input.reason,
      });
      return at;
    });
    // Slot length, buffers, notice and horizon all shape availability.
    await this.invalidate(true);
    return { key, value, updatedByUserId: actor.userId, updatedAt };
  }

  // ── internals ──

  private async load(): Promise<ConfigSnapshot> {
    const [options, settingRows] = await Promise.all([
      this.deps.optionsRepository.list({ activeOnly: true }),
      this.deps.optionsRepository.allSettings(),
    ]);
    const grouped = Object.fromEntries(OPTION_TYPES.map((t) => [t, [] as OptionView[]])) as Record<
      OptionType,
      OptionView[]
    >;
    for (const o of options) grouped[o.type].push(o);
    const settings = parseSettings(settingRows);
    const etag = `W/"${createHash('sha256')
      .update(JSON.stringify({ grouped, settings }))
      .digest('base64url')
      .slice(0, 22)}"`;
    return { options: grouped, settings, etag };
  }

  private async invalidate(availabilityChanged: boolean): Promise<void> {
    this.memo = undefined;
    try {
      await this.deps.cache.invalidate(callKeys.config());
    } catch (err) {
      this.deps.logger.warn({ err }, 'config cache invalidation failed (TTL bounds staleness)');
    }
    if (availabilityChanged) await this.deps.gens.bumpPool();
  }
}

/** The audited fields: only those the patch touched. */
const pick = (view: OptionView, patch: object): Record<string, unknown> =>
  Object.fromEntries(Object.keys(patch).map((k) => [k, view[k as keyof OptionView]]));
