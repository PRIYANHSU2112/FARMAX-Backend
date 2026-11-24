import { AppError, ErrorCode } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';
import type { WarehouseConfig } from '../config/index.js';

/** order-service `GET /internal/orders/:id/fulfilment-facts` (F1 / D-57b). */
export interface FulfilmentFacts {
  orderId: string;
  orderNo: string;
  userId: string;
  farmId: string;
  channel: string;
  status: string;
  fulfilmentStage: string | null;
  paymentStatus: string;
  paymentMethod: string;
  refundStatus: string;
  customerPoRef: string | null;
  deliveryPromise: string | null;
  placedAt: string;
  paidAt: string | null;
  confirmedAt: string | null;
  totals: Record<string, string>;
  customer: {
    name: string | null;
    phone: string | null;
    farmName: string | null;
    farmCode: string | null;
    gstin: string | null;
  };
  shipTo: {
    name: string | null;
    phone: string | null;
    line1: string | null;
    line2: string | null;
    landmark: string | null;
    village: string | null;
    mandal: string | null;
    district: string | null;
    stateCode: string | null;
    pinCode: string | null;
    latitude: number | null;
    longitude: number | null;
    formatted: string | null;
  };
  lines: {
    lineNo: number;
    variantId: string;
    productId: string;
    sku: string;
    name: string;
    temperatureClass: string;
    qty: number;
    cancelledQty: number;
    unitPrice: string;
    lineTotal: string;
  }[];
  payment: {
    method: string;
    instrument: string | null;
    providerRefMasked: string | null;
    capturedAt: string | null;
  };
  version: number;
}

/** Internal calls to order-service (service token). `null` = unavailable (callers retry later). */
export class OrderClient {
  constructor(private readonly deps: { config: WarehouseConfig; logger: Logger }) {}

  fulfilmentFacts(orderId: string): Promise<FulfilmentFacts | null> {
    return this.call<FulfilmentFacts>('GET', `/internal/orders/${orderId}/fulfilment-facts`);
  }

  counts(): Promise<Record<string, number> | null> {
    return this.call<Record<string, number>>('GET', '/internal/orders/counts');
  }

  /** W3.10 prepaid settlement: refund of units not delivered (idempotent per shipment). */
  async shortageRefund(
    orderId: string,
    body: { shipmentId: string; lines: { lineNo: number; qty: number }[] },
  ): Promise<{ sourceRef: string; amount: string }> {
    const r = await this.call<{ sourceRef: string; amount: string }>(
      'POST',
      '/internal/orders/' + orderId + '/shortage-refund',
      body,
    );
    if (r === null)
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Order service unavailable', 503);
    return r;
  }

  /**
   * D-57b W3.14 partial ship: cancel short units through the normal order cancel (refund +
   * reservation release; `order.cancelled.v1` shrinks the shipment lines). 503 when down.
   */
  async cancelLines(
    orderId: string,
    body: { lines: { variantId: string; qty: number }[]; note: string; by: string | null },
  ): Promise<{ orderId: string; status: string }> {
    const r = await this.call<{ orderId: string; status: string }>(
      'POST',
      `/internal/orders/${orderId}/cancel-lines`,
      { ...body, reasonCode: 'OTHER' },
    );
    if (r === null)
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Order service unavailable', 503);
    return r;
  }

  /** D-57b W3.15: change delivery details (order-service owns them). 503 when down. */
  async updateDelivery(orderId: string, body: object & { reason: string; by: string }) {
    const r = await this.call<{ id: string; version: number }>(
      'PATCH',
      '/internal/orders/' + orderId + '/delivery',
      body,
    );
    if (r === null)
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Order service unavailable', 503);
    return r;
  }

  /** Compliance rejection (§2a.7). Throws 503 when order-service cannot be reached. */
  async complianceReject(orderId: string, reason: string): Promise<{ status: string }> {
    const r = await this.call<{ status: string }>(
      'POST',
      `/internal/orders/${orderId}/compliance-reject`,
      { reason },
    );
    if (r === null)
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Order service unavailable', 503);
    return r;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: object,
  ): Promise<T | null> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return null;
    try {
      const res = await fetch(`${config.ORDER_SERVICE_URL}${path}`, {
        method,
        headers: {
          [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logger.warn(
          { status: res.status, path: path.split('/').slice(0, 3).join('/') },
          'order-service call failed',
        );
        return null;
      }
      return ((await res.json()) as { data: T }).data;
    } catch (err) {
      logger.warn({ err }, 'order-service unavailable');
      return null;
    }
  }
}
