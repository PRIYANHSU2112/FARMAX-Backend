import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { WarehouseConfig } from '../config/index.js';

/** payment-service `GET /internal/payments/stats` (capture clearance SLA). */
export interface PaymentStats {
  from: string;
  to: string;
  created: number;
  captured: number;
  failed: number;
  expired: number;
  cancelled: number;
  pending: number;
  capturedPaise: number;
  avgCaptureSec: number | null;
  p95CaptureSec: number | null;
  within5Min: number;
}

/** D-57b W3.18: read-only payment facts. `null` = payment-service unavailable. */
export class PaymentClient {
  constructor(private readonly deps: { config: WarehouseConfig; logger: Logger }) {}

  async stats(from: Date, to: Date): Promise<PaymentStats | null> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return null;
    try {
      const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
      const res = await fetch(
        `${config.PAYMENT_SERVICE_URL}/internal/payments/stats?${qs.toString()}`,
        {
          headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) {
        logger.warn({ status: res.status }, 'payment stats call failed');
        return null;
      }
      return ((await res.json()) as { data: PaymentStats }).data;
    } catch (err) {
      logger.warn({ err }, 'payment-service unavailable');
      return null;
    }
  }
}
