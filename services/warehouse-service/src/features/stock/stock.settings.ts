import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';
import {
  STOCK_SETTINGS,
  type StockSettingKey,
  type StockSettingValues,
  type WritesMode,
} from './stock.rules.js';

type Value<K extends StockSettingKey> = StockSettingValues[K];

/**
 * Stock settings (D-57a): code defaults overridden by `warehouse_settings` rows (GLOBAL, or a
 * per-warehouse scope). Reads are cached 15 s; the writes mode is always read fresh in the tx.
 */
export class StockSettings {
  private readonly repo: Cradle['stockRepository'];
  private cache: { at: number; values: Map<string, unknown> } | undefined;

  constructor({ stockRepository }: Pick<Cradle, 'stockRepository'>) {
    this.repo = stockRepository;
  }

  async get<K extends StockSettingKey>(key: K, scope = 'GLOBAL'): Promise<Value<K>> {
    const all = await this.all(scope);
    return all[key];
  }

  /** Every stock setting with its effective value (scope override → GLOBAL → default). */
  async all(scope = 'GLOBAL'): Promise<{ [K in StockSettingKey]: Value<K> }> {
    const cacheKey = (k: string, s: string) => `${s}|${k}`;
    if (this.cache === undefined || Date.now() - this.cache.at > 15_000) {
      const rows = await this.repo.settings(Object.keys(STOCK_SETTINGS), scope);
      this.cache = {
        at: Date.now(),
        values: new Map(rows.map((r) => [cacheKey(r.key, r.scope), r.value])),
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(STOCK_SETTINGS)) {
      const v =
        this.cache.values.get(cacheKey(k, scope)) ?? this.cache.values.get(cacheKey(k, 'GLOBAL'));
      out[k] = v ?? def;
    }
    return out as { [K in StockSettingKey]: Value<K> };
  }

  async writesMode(tx?: Tx): Promise<WritesMode> {
    const rows = await this.repo.settings(['stock.writesMode'], 'GLOBAL', tx);
    return (rows.find((r) => r.scope === 'GLOBAL')?.value as WritesMode | undefined) ?? 'INVENTORY';
  }

  async set(tx: Tx, key: StockSettingKey, value: unknown, userId: string | null, scope = 'GLOBAL') {
    await this.repo.setSetting(tx, key, value, userId, scope);
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
