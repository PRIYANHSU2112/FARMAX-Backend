import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import {
  FULFILMENT_SETTINGS,
  type FulfilmentSettingKey,
  type FulfilmentSettingValues,
} from './fulfilment.rules.js';

export const FULFILMENT_KEYS = Object.keys(FULFILMENT_SETTINGS) as FulfilmentSettingKey[];

/**
 * Fulfilment settings (D-57b): code defaults overridden by `warehouse_settings` rows (GLOBAL or a
 * per-warehouse scope), stored through the stock settings table. Cached 15 s per scope.
 */
export class FulfilmentSettings {
  private readonly cache = new Map<string, { at: number; values: FulfilmentSettingValues }>();

  constructor(private readonly deps: Pick<Cradle, 'stockSettings'>) {}

  async all(scope = 'GLOBAL'): Promise<FulfilmentSettingValues> {
    const hit = this.cache.get(scope);
    if (hit !== undefined && Date.now() - hit.at < 15_000) return hit.values;
    const raw = await this.deps.stockSettings.raw(FULFILMENT_KEYS, scope);
    const values = { ...FULFILMENT_SETTINGS } as Record<string, unknown>;
    for (const k of FULFILMENT_KEYS) if (raw.has(k)) values[k] = raw.get(k);
    const typed = values as unknown as FulfilmentSettingValues;
    this.cache.set(scope, { at: Date.now(), values: typed });
    return typed;
  }

  async get<K extends FulfilmentSettingKey>(
    key: K,
    scope = 'GLOBAL',
  ): Promise<FulfilmentSettingValues[K]> {
    return (await this.all(scope))[key];
  }

  async set(
    tx: Tx,
    key: FulfilmentSettingKey,
    value: unknown,
    userId: string | null,
    scope = 'GLOBAL',
  ) {
    await this.deps.stockSettings.setRaw(tx, key, value, userId, scope);
    this.cache.clear();
  }
}
