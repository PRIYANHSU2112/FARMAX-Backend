import { InternalError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { RoutingRulesReplacedV1 } from '@farmx/infra/events';
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

export type StockWritesMode = 'INVENTORY' | 'FROZEN' | 'WMS';

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
  private readonly availabilityPublisher: Cradle['availabilityPublisher'];
  private cached: { at: number; view: SettingsView } | undefined;

  constructor({
    settingsRepository,
    runInTransaction,
    auditService,
    availabilityPublisher,
  }: Pick<
    Cradle,
    'settingsRepository' | 'runInTransaction' | 'auditService' | 'availabilityPublisher'
  >) {
    this.repo = settingsRepository;
    this.runInTransaction = runInTransaction;
    this.auditService = auditService;
    this.availabilityPublisher = availabilityPublisher;
  }

  /**
   * D-57a cutover: who writes stock. INVENTORY (before the cutover) · FROZEN (cutover running; stock
   * and threshold writes refused) · WMS (warehouse-service owns physical stock and thresholds).
   * Read fresh (never cached) so a freeze is effective at once.
   */
  async writesMode(tx?: Tx): Promise<StockWritesMode> {
    const v = await this.repo.raw('stock.writesMode', tx);
    return v === 'FROZEN' || v === 'WMS' ? v : 'INVENTORY';
  }

  async setWritesMode(tx: Tx, mode: StockWritesMode, userId: string | null): Promise<void> {
    await this.repo.setRaw(tx, 'stock.writesMode', mode, userId);
  }

  /** D-57b W3.12: the routing snapshot from warehouse-service (cached 15 s per process). */
  async routingSnapshot(): Promise<RoutingRulesReplacedV1 | null> {
    if (this.routingCache !== undefined && Date.now() - this.routingCache.at < 15_000)
      return this.routingCache.value;
    const v = (await this.repo.raw('routing.snapshot')) as RoutingRulesReplacedV1 | null;
    this.routingCache = { at: Date.now(), value: v };
    return v;
  }

  /** Applies a newer routing snapshot (older / duplicate deliveries are ignored). */
  async applyRoutingSnapshot(tx: Tx, d: RoutingRulesReplacedV1): Promise<boolean> {
    const cur = (await this.repo.raw('routing.snapshot', tx)) as RoutingRulesReplacedV1 | null;
    if (cur !== null && cur.version >= d.version) return false;
    await this.repo.setRaw(tx, 'routing.snapshot', d, null);
    this.routingCache = undefined;
    return true;
  }

  private routingCache: { at: number; value: RoutingRulesReplacedV1 | null } | undefined;

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
    const floorChanged = await this.runInTransaction(async (tx) => {
      const before = parse(await this.repo.lockAll(tx));
      const changed = SETTING_KEYS.filter(
        (key) => changes[key] !== undefined && changes[key] !== before[key],
      );
      if (changed.length === 0) return false;
      for (const key of changed) await this.repo.upsert(tx, key, changes[key], actor.userId);
      await this.auditService.record(tx, actor, {
        action: 'settings.update',
        targetType: 'settings',
        targetId: 'inventory',
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, changes[k]])),
        reason,
      });
      return changed.includes('bufferFloorPct');
    });
    this.cached = undefined;
    // D-57b W3.13: a new buffer floor changes what the storefront may show → recompute all.
    if (floorChanged) await this.availabilityPublisher.resync(null, false);
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
