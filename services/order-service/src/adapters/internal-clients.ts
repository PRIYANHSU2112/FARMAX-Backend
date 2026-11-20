import { AppError, ErrorCode, ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { OrderConfig } from '../config/index.js';

/**
 * Service-to-service HTTP (`/internal/*`, shared token, never through the gateway). Every call
 * here is idempotent on the other side (keys = order id), so a network failure is retried once;
 * a still-unknown outcome surfaces as 503 and is resolved by a retry or the stuck-orders job.
 */

/** A 4xx answer from another service: its business reason travels with it. */
export class UpstreamRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'UpstreamRefusal';
  }

  get reason(): string | undefined {
    return (this.details as { reason?: string } | undefined)?.reason;
  }

  /** Re-throw to OUR caller with the same status / code / details. */
  toAppError(): AppError {
    const code = (Object.values(ErrorCode) as string[]).includes(this.code)
      ? (this.code as ErrorCode)
      : ErrorCode.CONFLICT;
    return new AppError(code, this.message, this.status, { details: this.details });
  }
}

type Method = 'GET' | 'POST';

class InternalHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly name: string,
    private readonly deps: { config: OrderConfig; logger: Logger },
  ) {}

  async call<T>(
    method: Method,
    path: string,
    o: { body?: object; idempotencyKey?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const token = this.deps.config.INTERNAL_SERVICE_TOKEN;
    if (token === undefined)
      throw new ServiceUnavailableError(`${this.name} is not configured (INTERNAL_SERVICE_TOKEN)`);
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            [INTERNAL_TOKEN_HEADER]: token,
            ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(o.idempotencyKey === undefined ? {} : { 'idempotency-key': o.idempotencyKey }),
          },
          ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
          signal: AbortSignal.timeout(o.timeoutMs ?? 4_000),
        });
      } catch (err) {
        if (attempt < 2) continue;
        this.deps.logger.warn({ err, service: this.name, path }, 'internal call failed');
        throw new ServiceUnavailableError(`${this.name} is unavailable; try again`, { cause: err });
      }
      const body = (await res.json().catch(() => ({}))) as {
        data?: T;
        error?: { code?: string; message?: string; details?: unknown };
      };
      if (res.ok) return body.data as T;
      if (res.status >= 500 || res.status === 429) {
        if (attempt < 2 && res.status !== 429) continue;
        throw new ServiceUnavailableError(`${this.name} is unavailable; try again`);
      }
      throw new UpstreamRefusal(
        res.status,
        body.error?.code ?? 'CONFLICT',
        body.error?.message ?? `${this.name} refused the request`,
        body.error?.details,
      );
    }
  }
}

// ── inventory-service ──

export interface ReservationLine {
  warehouseId: string;
  variantId: string;
  qty: number;
}
export interface Reservation {
  id: string;
  orderRef: string;
  status: string;
  lines: ReservationLine[];
  split?: boolean;
}

export class InventoryClient {
  private readonly http: InternalHttp;

  constructor(deps: { config: OrderConfig; logger: Logger }) {
    this.http = new InternalHttp(deps.config.INVENTORY_SERVICE_URL, 'inventory-service', deps);
  }

  reserve(input: {
    orderId: string;
    pinCode: string;
    lines: { variantId: string; qty: number }[];
    ttlSeconds: number;
  }): Promise<Reservation> {
    return this.http.call('POST', '/internal/inventory/reservations', {
      idempotencyKey: `order-${input.orderId}`,
      body: {
        orderRef: input.orderId,
        pinCode: input.pinCode,
        lines: input.lines,
        ttlSeconds: input.ttlSeconds,
      },
    });
  }

  byOrder(orderId: string): Promise<Reservation[]> {
    return this.http.call('GET', `/internal/inventory/reservations?orderRef=${orderId}`);
  }
}

// ── payment-service ──

export interface PaymentCheckout {
  paymentId: string;
  paymentNo: string;
  status: string;
  provider: string;
  keyId: string;
  providerOrderId: string | null;
  amountPaise: number;
  amount: string;
  currency: string;
  expiresAt: string;
}

export interface PaymentState {
  id: string;
  status: string;
  capturedPaise: number;
}

export class PaymentClient {
  private readonly http: InternalHttp;

  constructor(deps: { config: OrderConfig; logger: Logger }) {
    this.http = new InternalHttp(deps.config.PAYMENT_SERVICE_URL, 'payment-service', deps);
  }

  /** Create or reuse the order's payment (one per order; "pay again" reuses its gateway order). */
  createForOrder(input: {
    orderId: string;
    orderNo: string;
    userId: string;
    amountPaise: number;
    expiresAt: Date;
  }): Promise<PaymentCheckout> {
    return this.http.call('POST', '/internal/payments', {
      body: { ...input, currency: 'INR', expiresAt: input.expiresAt.toISOString() },
    });
  }

  /** Stored totals of one payment (ledger reconciliation; no gateway call). */
  async totals(paymentId: string): Promise<{ capturedPaise: number; refundedPaise: number }> {
    const p = await this.http.call<{ capturedPaise: number; refundedPaise: number }>(
      'GET',
      `/internal/payments/${paymentId}`,
    );
    return { capturedPaise: p.capturedPaise, refundedPaise: p.refundedPaise };
  }

  /** Gateway refetch (lost-webhook guard before timing an order out). */
  liveStatus(paymentId: string): Promise<PaymentState> {
    return this.http.call('GET', `/internal/payments/${paymentId}/live-status`, {
      timeoutMs: 12_000,
    });
  }
}

// ── user-service ──

export interface AddressSnapshot {
  addressId: string;
  userId: string;
  version: number;
  deleted: boolean;
  formatted: string;
  contactName: string;
  contactPhone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  village: string | null;
  mandal: string | null;
  district: string;
  stateCode: string;
  pinCode: string;
  latitude: number | null;
  longitude: number | null;
}

export class AddressClient {
  private readonly http: InternalHttp;

  constructor(deps: { config: OrderConfig; logger: Logger }) {
    this.http = new InternalHttp(deps.config.USER_SERVICE_URL, 'user-service', deps);
  }

  snapshot(userId: string, addressId: string): Promise<AddressSnapshot> {
    return this.http.call('GET', `/internal/users/${userId}/addresses/${addressId}`);
  }
}
