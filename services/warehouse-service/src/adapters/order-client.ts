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

/** order-service `POST /internal/orders/:id/shipments/:shipmentId/invoice` (D-61). */
export interface ShipmentInvoice {
  docId: string;
  docNo: string;
  docType: string;
  grandTotalPaise: number;
  grandTotal: string;
  issuedAt: string;
  linesHash: string;
  replayed: boolean;
  voidedDocNo: string | null;
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

  /**
   * D-61 gate-out step 1: issue (or replay) the shipment's GST invoice. Idempotent per shipment +
   * lines, so a timeout / 5xx is retried once safely. 409 from order-service (INVOICE_INVALID,
   * ALREADY_DISPATCHED, LINES_HASH_MISMATCH…) → `{ ok: false, conflict }`; unreachable → 503.
   */
  async issueShipmentInvoice(
    orderId: string,
    shipmentId: string,
    body: { lines: { lineNo: number; qty: number }[]; linesHash: string; by: string | null },
  ): Promise<
    | { ok: true; invoice: ShipmentInvoice }
    | { ok: false; conflict: { message: string; details: unknown } }
  > {
    const path = `/internal/orders/${orderId}/shipments/${shipmentId}/invoice`;
    for (let attempt = 1; ; attempt += 1) {
      const r = await this.send('POST', path, body, 3_000);
      if (r.kind === 'ok') return { ok: true, invoice: (r.body as { data: ShipmentInvoice }).data };
      if (r.kind === 'error' && r.status === 409) {
        const e = (r.body as { error?: { message?: string; details?: unknown } } | null)?.error;
        return {
          ok: false,
          conflict: { message: e?.message ?? 'Invoice refused', details: e?.details ?? null },
        };
      }
      const retryable = r.kind === 'unreachable' || r.status >= 500;
      if (!retryable || attempt >= 2)
        throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Invoice service unavailable', 503, {
          details: { reason: 'INVOICE_UNAVAILABLE' },
        });
    }
  }

  /** D-61 warehouse print: the active invoice PDF of a shipment; null when none is issued yet. */
  async shipmentInvoicePdf(
    orderId: string,
    shipmentId: string,
  ): Promise<{ file: Buffer; docNo: string } | null> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined)
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Order service unavailable', 503);
    try {
      const res = await fetch(
        `${config.ORDER_SERVICE_URL}/internal/orders/${orderId}/invoices/by-shipment/${shipmentId}/pdf`,
        {
          headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`order-service answered ${String(res.status)}`);
      return {
        file: Buffer.from(await res.arrayBuffer()),
        docNo: res.headers.get('x-document-no') ?? '',
      };
    } catch (err) {
      logger.warn({ err }, 'invoice PDF fetch failed');
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Order service unavailable', 503);
    }
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

  /** Raw call that keeps the status and body (callers that must read 409 details). */
  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: object | undefined,
    timeoutMs: number,
  ): Promise<
    | { kind: 'ok'; body: unknown }
    | { kind: 'error'; status: number; body: unknown }
    | { kind: 'unreachable' }
  > {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return { kind: 'unreachable' };
    try {
      const res = await fetch(`${config.ORDER_SERVICE_URL}${path}`, {
        method,
        headers: {
          [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const parsed: unknown = await res.json().catch(() => null);
      if (res.ok) return { kind: 'ok', body: parsed };
      logger.warn(
        { status: res.status, path: path.split('/').slice(0, 3).join('/') },
        'order-service call refused',
      );
      return { kind: 'error', status: res.status, body: parsed };
    } catch (err) {
      logger.warn({ err }, 'order-service unavailable');
      return { kind: 'unreachable' };
    }
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
