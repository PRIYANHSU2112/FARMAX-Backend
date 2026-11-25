import type { UserConfig } from '../config/index.js';
import { getJson } from './http.js';

/** order-service order summary (passed through unchanged). */
export interface OrderSummary {
  id: string;
  orderNo: string;
  status: string;
  [field: string]: unknown;
}

/** order-service CUSTOMER routes, called with the caller's own bearer token. */
export class OrderClient {
  constructor(private readonly deps: { config: UserConfig }) {}

  /** The newest active order only (`tab=active&limit=1`), or null. */
  async latestActiveOrder(bearer: string, timeoutMs: number): Promise<OrderSummary | null> {
    const body = await getJson<{ data?: OrderSummary[] }>(
      `${this.deps.config.ORDER_SERVICE_URL}/orders?tab=active&limit=1`,
      { bearer, timeoutMs },
    );
    return body.data?.[0] ?? null;
  }
}
