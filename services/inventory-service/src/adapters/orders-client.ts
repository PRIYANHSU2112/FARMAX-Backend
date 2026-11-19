import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';
import type { Logger } from '@farmx/common/logger';

import type { InventoryConfig } from '../config/index.js';

export interface OrderStatusRow {
  id: string;
  status: string;
}

/**
 * order-service `/internal/orders/status?ids=` (docs/oms/05-api.md), used only by the nightly
 * orphan sweep. Any failure → null (the sweep skips this run; it never guesses an order's state).
 */
export class OrdersClient {
  constructor(private readonly deps: { config: InventoryConfig; logger: Logger }) {}

  async statuses(ids: readonly string[]): Promise<OrderStatusRow[] | null> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined || ids.length === 0) return null;
    try {
      const url = `${config.ORDER_SERVICE_URL}/internal/orders/status?ids=${ids.join(',')}`;
      const res = await fetch(url, {
        headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'order status lookup failed; orphan sweep skipped');
        return null;
      }
      const body = (await res.json()) as { data?: OrderStatusRow[] };
      return body.data ?? null;
    } catch (err) {
      logger.warn({ err }, 'order-service unreachable; orphan sweep skipped');
      return null;
    }
  }
}
