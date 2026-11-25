import type { Logger } from '@farmx/common/logger';
import { ConflictError, ServiceUnavailableError } from '@farmx/common/errors';
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

  // ── D-57a cutover handshake (throws ServiceUnavailableError when inventory is down) ──

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined)
      throw new ServiceUnavailableError('Internal service token is not configured');
    let res: Response;
    try {
      res = await fetch(`${config.INVENTORY_SERVICE_URL}/internal/inventory${path}`, {
        method,
        headers: {
          [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      logger.warn({ err, path }, 'inventory-service unavailable');
      throw new ServiceUnavailableError('inventory-service is unavailable');
    }
    const json = (await res.json().catch(() => ({}))) as {
      data?: T;
      error?: { message?: string; details?: unknown };
    };
    if (!res.ok) {
      if (res.status === 409)
        throw new ConflictError(json.error?.message ?? 'inventory refused the cutover step', {
          details: json.error?.details,
        });
      logger.warn({ status: res.status, path }, 'inventory cutover call failed');
      throw new ServiceUnavailableError('inventory-service refused the call');
    }
    return json.data as T;
  }

  /** Raw call: status + body; network failure → status 0. */
  private async raw(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return { status: 0, json: {} as never };
    try {
      const res = await fetch(`${config.INVENTORY_SERVICE_URL}/internal/inventory${path}`, {
        method,
        headers: {
          [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: unknown;
        meta?: { nextCursor?: string | null };
        error?: { message?: string; details?: { reason?: string } };
      };
      return { status: res.status, json };
    } catch (err) {
      logger.warn({ err, path }, 'inventory-service unavailable');
      return { status: 0, json: {} as never };
    }
  }

  /**
   * D-57b §2a.4: move held reservation lines between warehouses (idempotent by `key`).
   * `definitive` = inventory refused (404 / 409 / 422): nothing to retry. Otherwise retry later.
   */
  async reallocate(
    reservationId: string,
    key: string,
    moves: readonly {
      variantId: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      qty: number;
    }[],
  ): Promise<
    | { ok: true; replayed: boolean }
    | { ok: false; definitive: boolean; reason: string; message: string }
  > {
    const r = await this.raw('POST', `/reservations/${reservationId}/reallocate`, { key, moves });
    if (r.status >= 200 && r.status < 300)
      return { ok: true, replayed: (r.json.data as { replayed?: boolean }).replayed === true };
    const definitive = r.status === 404 || r.status === 409 || r.status === 422;
    return {
      ok: false,
      definitive,
      reason:
        r.json.error?.details?.reason ??
        (r.status === 0 ? 'UNAVAILABLE' : `HTTP_${String(r.status)}`),
      message: r.json.error?.message ?? 'inventory-service did not answer',
    };
  }

  /** D-57b §2a.3: held reservation lines at a warehouse (allocation reconcile). null = down. */
  async openLines(warehouseId: string, cursor: string | undefined, limit = 200) {
    const qs = new URLSearchParams({
      warehouseId,
      limit: String(limit),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const r = await this.raw('GET', `/reservations-open-lines?${qs.toString()}`);
    if (r.status !== 200) return null;
    return {
      items: (r.json.data ?? []) as {
        reservationId: string;
        orderRef: string;
        variantId: string;
        heldQty: number;
        issuedQty: number;
      }[],
      nextCursor: r.json.meta?.nextCursor ?? null,
    };
  }

  cutoverState() {
    return this.call<{
      mode: 'INVENTORY' | 'FROZEN' | 'WMS';
      pendingOperations: { id: string; type: string; warehouseId: string; createdAt: string }[];
    }>('GET', '/cutover/state');
  }

  cutoverStep(step: 'freeze' | 'unfreeze' | 'activate' | 'rollback', by: string | null) {
    return this.call<{ mode: string }>('POST', `/cutover/${step}`, { by });
  }

  rejectPending(reason: string) {
    return this.call<string[]>('POST', '/cutover/reject-pending', { reason });
  }

  snapshot(cursor: string | undefined, limit = 2000) {
    const qs = new URLSearchParams({
      limit: String(limit),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return this.call<InventoryLevel[]>('GET', `/cutover/snapshot?${qs.toString()}`);
  }

  ledgerSince(since: Date, cursor: string | undefined, limit = 2000) {
    const qs = new URLSearchParams({
      since: since.toISOString(),
      limit: String(limit),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return this.call<InventoryLedgerRow[]>('GET', `/cutover/ledger-since?${qs.toString()}`);
  }

  // ── D-57b W3.13 ATP: inventory owns the buffer floor + cart-hold lease; Sync Now ──

  /** null = inventory unavailable (the screen shows `modules.inventory: false`). */
  async availabilitySettings(): Promise<InventoryAvailabilitySettings | null> {
    const r = await this.raw('GET', '/availability-settings');
    return r.status === 200 ? (r.json.data as InventoryAvailabilitySettings) : null;
  }

  async setAvailabilitySettings(body: {
    bufferFloorPct?: number;
    reservationTtlSeconds?: number;
    reason: string;
    by: string | null;
    requestId: string;
  }): Promise<InventoryAvailabilitySettings> {
    const r = await this.raw('PATCH', '/availability-settings', body);
    if (r.status === 200) return r.json.data as InventoryAvailabilitySettings;
    if (r.status === 422 || r.status === 409)
      throw new ConflictError(r.json.error?.message ?? 'inventory refused the settings', {
        details: r.json.error?.details,
      });
    throw new ServiceUnavailableError('inventory-service is unavailable');
  }

  async resyncAvailability(warehouseId: string | null): Promise<{ variants: number }> {
    const r = await this.raw('POST', '/availability/resync', { warehouseId });
    if (r.status === 200) return r.json.data as { variants: number };
    throw new ServiceUnavailableError('inventory-service is unavailable');
  }
}

export interface InventoryAvailabilitySettings {
  bufferFloorPct: number;
  reservationTtlSeconds: number;
  allowSplitAllocation: boolean;
  updatedAt: string | null;
}

export interface InventoryLevel {
  id: string;
  warehouseId: string;
  variantId: string;
  onHand: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
  reorderLevel: number;
}

export interface InventoryLedgerRow {
  id: string;
  warehouseId: string;
  variantId: string;
  type: string;
  onHandDelta: number;
  damagedDelta: number;
  createdAt: string;
}
