import type { Logger } from '@farmx/common/logger';
import { type Redis, warehouseKeys } from '@farmx/infra/redis';

import type { WarehouseConfig } from '../config/index.js';

interface Node {
  id: string;
  name: string;
  children?: Node[];
}

const TTL_SECONDS = 600;

/**
 * Visible catalog categories (id → name) from catalog-service's public tree, cached 10 minutes.
 * `null` = catalog unavailable: callers then skip category checks instead of flagging everything.
 */
export class CatalogClient {
  constructor(
    private readonly deps: { config: WarehouseConfig; logger: Logger; redis: () => Redis },
  ) {}

  async categories(): Promise<Map<string, string> | null> {
    const { redis, logger, config } = this.deps;
    const key = warehouseKeys.categories();
    try {
      const cached = await redis().get(key);
      if (cached !== null) return new Map(JSON.parse(cached) as [string, string][]);
    } catch (err) {
      logger.warn({ err }, 'category cache unavailable');
    }
    try {
      const res = await fetch(`${config.CATALOG_SERVICE_URL}/catalog/categories`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: Node[] };
      const flat = new Map<string, string>();
      const walk = (nodes: readonly Node[]) => {
        for (const n of nodes) {
          flat.set(n.id, n.name);
          walk(n.children ?? []);
        }
      };
      walk(body.data ?? []);
      await redis()
        .set(key, JSON.stringify([...flat]), 'EX', TTL_SECONDS)
        .catch(() => undefined);
      return flat;
    } catch (err) {
      logger.warn({ err }, 'catalog-service category lookup failed');
      return null;
    }
  }
}
