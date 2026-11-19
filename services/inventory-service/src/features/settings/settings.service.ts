import { InternalError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import type { SettingRow } from './settings.repository.js';
import type {
  InventorySettings,
  SettingKey,
  SettingsView,
  UpdateSettingsInput,
} from './settings.types.js';
import { SETTING_KEYS, SETTING_RULES } from './settings.validation.js';

/** In-process cache: reservations read settings on every call. A change is live within this. */
const CACHE_MS = 15_000;

/**
 * Settings are database rows (never code constants). A missing or invalid row is a deployment
 * error (the migration seeds every key), so it fails loudly instead of guessing a value.
 */
export class SettingsService {
  private readonly repo: Cradle['settingsRepository'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly auditService: Cradle['auditService'];
  private cached: { at: number; view: SettingsView } | undefined;

  constructor({
    settingsRepository,
    runInTransaction,
    auditService,
  }: Pick<Cradle, 'settingsRepository' | 'runInTransaction' | 'auditService'>) {
    this.repo = settingsRepository;
    this.runInTransaction = runInTransaction;
    this.auditService = auditService;
  }

  /** Current settings (cached ≤ 15 s per process). */
  async current(): Promise<InventorySettings> {
    return this.view();
  }

  async view(): Promise<SettingsView> {
    const now = Date.now();
    if (this.cached !== undefined && now - this.cached.at < CACHE_MS) return this.cached.view;
    const view = parse(await this.repo.all());
    this.cached = { at: now, view };
    return view;
  }

  async update(actor: Actor, input: UpdateSettingsInput): Promise<SettingsView> {
    const { reason, ...changes } = input;
    await this.runInTransaction(async (tx) => {
      const before = parse(await this.repo.lockAll(tx));
      const changed = SETTING_KEYS.filter(
        (key) => changes[key] !== undefined && changes[key] !== before[key],
      );
      if (changed.length === 0) return;
      for (const key of changed) await this.repo.upsert(tx, key, changes[key], actor.userId);
      await this.auditService.record(tx, actor, {
        action: 'settings.update',
        targetType: 'settings',
        targetId: 'inventory',
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, changes[k]])),
        reason,
      });
    });
    this.cached = undefined;
    return this.view();
  }
}

const parse = (rows: SettingRow[]): SettingsView => {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const values: Partial<Record<SettingKey, unknown>> = {};
  let updatedAt: Date | null = null;
  for (const key of SETTING_KEYS) {
    const row = byKey.get(key);
    const checked = SETTING_RULES[key].validate(row?.value, { presence: 'required' });
    if (row === undefined || checked.error !== undefined)
      throw new InternalError(`inventory setting "${key}" is missing or invalid`);
    values[key] = checked.value;
    if (updatedAt === null || row.updatedAt > updatedAt) updatedAt = row.updatedAt;
  }
  return { ...(values as unknown as InventorySettings), updatedAt };
};
