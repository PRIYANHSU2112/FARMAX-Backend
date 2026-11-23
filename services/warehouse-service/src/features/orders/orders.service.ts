import type { Tx } from '@farmx/database';
import type {
  OrderConfirmedV1,
  OrderDeliveredV1,
  OrderPlacedV1,
  OrderStockReleaseV1,
  ReservationCommittedV1,
  ReservationReleasedV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import {
  type FulfilmentStatus,
  OPEN_STATUSES,
  byWarehouse,
  countsOf,
  subtractLines,
} from './orders.rules.js';
import type {
  AllocationRow,
  HeaderRow,
  OpenOrderCounts,
  OrderListQuery,
  WarehouseOrderView,
} from './orders.types.js';

const view = (a: AllocationRow, h: HeaderRow | undefined): WarehouseOrderView => ({
  orderId: a.orderId,
  orderNo: h?.orderNo ?? null,
  shipToName: h?.shipToName ?? null,
  district: h?.district ?? null,
  pinCode: h?.pinCode ?? null,
  lineCount: a.lineCount,
  unitCount: a.unitCount,
  status: a.status,
  placedAt: h?.placedAt.toISOString() ?? null,
  paidAt: a.paidAt.toISOString(),
  confirmedAt: a.confirmedAt?.toISOString() ?? null,
  deliveredAt: a.deliveredAt?.toISOString() ?? null,
  cancelledAt: a.cancelledAt?.toISOString() ?? null,
});

/**
 * Orders each warehouse must fulfil (D-56 P3), fed by events inside the inbox transaction:
 *   order.placed                       → header (order no, ship-to)
 *   inventory.reservation_committed    → one NEW row per warehouse holding stock (paid)
 *   order.confirmed                    → ALLOCATED (admin confirmed; pick, pack, dispatch)
 *   order.delivered                    → DELIVERED
 *   order.rejected / cancelled / failed (FULL), inventory.reservation_released (FULL) → CANCELLED
 *   inventory.reservation_released (PARTIAL, per warehouse) → units reduced; none left → CANCELLED
 * Status only moves forward; terminal rows never change, so redelivery and reordering are safe.
 */
export class OrdersService {
  private readonly repo: Cradle['ordersRepository'];
  private readonly lazy: Pick<Cradle, 'warehousesService'>;
  private readonly logger: Cradle['logger'];

  constructor(deps: Pick<Cradle, 'ordersRepository' | 'warehousesService' | 'logger'>) {
    this.repo = deps.ordersRepository;
    this.lazy = deps;
    this.logger = deps.logger;
  }

  // ── Reads ──

  async list(caller: Caller, warehouseId: string, query: OrderListQuery) {
    await this.lazy.warehousesService.requireVisible(caller, warehouseId, 'warehouse.view');
    const statuses: FulfilmentStatus[] = query.status === 'OPEN' ? OPEN_STATUSES : [query.status];
    const { rows, total } = await this.repo.page(warehouseId, statuses, query.cursor, query.limit);
    const page = rows.slice(0, query.limit);
    const headers = new Map(
      (await this.repo.headers(page.map((r) => r.orderId))).map((h) => [h.orderId, h]),
    );
    return {
      items: page.map((r) => view(r, headers.get(r.orderId))),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.orderId ?? null) : null,
      limit: query.limit,
      total,
    };
  }

  openCounts(warehouseIds: readonly string[], tx?: Tx): Promise<Map<string, OpenOrderCounts>> {
    return this.repo.openCounts(warehouseIds, tx);
  }

  // ── Event appliers (inbox transaction) ──

  applyPlaced(tx: Tx, d: OrderPlacedV1, at: Date): Promise<void> {
    return this.repo.upsertHeader(tx, {
      orderId: d.orderId,
      orderNo: d.orderNo,
      shipToName: d.shipTo?.name.slice(0, 120) ?? null,
      district: d.shipTo?.district?.slice(0, 80) ?? null,
      pinCode: d.shipTo?.pinCode ?? null,
      placedAt: at,
    });
  }

  async applyCommitted(tx: Tx, d: ReservationCommittedV1, at: Date): Promise<void> {
    if (d.lines === undefined) {
      this.logger.warn({ orderId: d.orderRef }, 'reservation_committed without lines (pre D-56)');
      return;
    }
    await this.repo.insertAllocations(
      tx,
      [...byWarehouse(d.lines)].map(([warehouseId, lines]) => ({
        orderId: d.orderRef,
        warehouseId,
        status: 'NEW' as const,
        lines,
        ...countsOf(lines),
        paidAt: at,
        lastEventAt: at,
      })),
    );
  }

  async applyConfirmed(tx: Tx, d: OrderConfirmedV1, at: Date): Promise<void> {
    await this.repo.move(tx, d.orderId, ['NEW'], {
      status: 'ALLOCATED',
      confirmedAt: new Date(d.confirmedAt),
      lastEventAt: at,
    });
  }

  async applyDelivered(tx: Tx, d: OrderDeliveredV1, at: Date): Promise<void> {
    await this.repo.move(tx, d.orderId, OPEN_STATUSES, {
      status: 'DELIVERED',
      deliveredAt: new Date(d.deliveredAt),
      lastEventAt: at,
    });
  }

  /** order.rejected / cancelled / failed: a FULL stop cancels every open allocation. */
  async applyStopped(tx: Tx, d: OrderStockReleaseV1, at: Date): Promise<void> {
    if (d.scope !== 'FULL') return; // partial: the per-warehouse reservation_released follows
    await this.cancelAll(tx, d.orderId, at);
  }

  async applyReleased(tx: Tx, d: ReservationReleasedV1, at: Date): Promise<void> {
    if (d.scope === 'FULL') {
      await this.cancelAll(tx, d.orderRef, at);
      return;
    }
    const open = await this.repo.lockOpen(tx, d.orderRef);
    for (const a of open) {
      const release = d.lines.filter((l) => l.warehouseId === a.warehouseId);
      if (release.length === 0) continue;
      const lines = subtractLines(a.lines, release);
      const counts = countsOf(lines);
      await this.repo.update(tx, a.orderId, a.warehouseId, {
        lines,
        ...counts,
        lastEventAt: at,
        ...(counts.unitCount === 0 ? { status: 'CANCELLED', cancelledAt: at } : {}),
      });
    }
  }

  private async cancelAll(tx: Tx, orderId: string, at: Date): Promise<void> {
    await this.repo.move(tx, orderId, OPEN_STATUSES, {
      status: 'CANCELLED',
      cancelledAt: at,
      lastEventAt: at,
    });
  }
}
