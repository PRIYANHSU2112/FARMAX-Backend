import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { WarehouseConfig } from '../config/index.js';

/** inventory-service `GET /internal/inventory/warehouse-stats` (one row per warehouse with stock). */
export interface InventoryWarehouseStats {
  warehouseId: string;
  onHand: number;
  reserved: number;
  damaged: number;
  available: number;
  skuCount: number;
  usedKg: string;
  weighedUnits: number;
  unweighedUnits: number;
  unweighedSkus: number;
  weightKnownPct: number;
  categories: {
    rootCategoryId: string | null;
    skuCount: number;
    onHand: number;
    reserved: number;
    available: number;
  }[];
}

/** Pulls stock figures for the stats job. `null` = inventory unavailable (screens keep the last snapshot). */
export class InventoryClient {
  constructor(private readonly deps: { config: WarehouseConfig; logger: Logger }) {}

  async warehouseStats(): Promise<InventoryWarehouseStats[] | null> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return null;
    try {
      const res = await fetch(
        `${config.INVENTORY_SERVICE_URL}/internal/inventory/warehouse-stats`,
        {
          headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) {
        logger.warn({ status: res.status }, 'inventory warehouse-stats failed');
        return null;
      }
      const body = (await res.json()) as { data?: InventoryWarehouseStats[] };
      return body.data ?? [];
    } catch (err) {
      logger.warn({ err }, 'inventory-service unavailable for warehouse stats');
      return null;
    }
  }
}
