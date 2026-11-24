import { ConflictError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { emitWarehouseEvent } from '../../adapters/events.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { Access } from '../../middleware/access.js';
import type { StockMove } from '../stock/index.js';
import type {
  AllocationRow,
  DailyField,
  ShipmentRow,
  ShipmentUpdate,
} from './fulfilment.repository.js';
import { NEXT, STAMP, type ShipmentStatus, blockedByHold, istDay } from './fulfilment.rules.js';

/** Who moved a shipment (timeline + audit). */
export interface FlowActor {
  type: 'STAFF' | 'SYSTEM' | 'SERVICE' | 'DRIVER';
  id: string | null;
  requestId?: string | null;
  /** Staff grants: stock moves are checked against the lifecycle table with them. */
  access?: Access;
}

export const SYSTEM_ACTOR: FlowActor = { type: 'SYSTEM', id: null };

const minutes = (a: Date | null, b: Date) =>
  a === null ? undefined : Math.max(0, (b.getTime() - a.getTime()) / 60_000);

/**
 * The ONE way a shipment changes status (D-57b §3.2): state-machine + hold guard, timestamp,
 * append-only timeline row, daily counters and `shipment.status_changed.v1` (with a snapshot of
 * every shipment of the order, so order-service derives the order status), all in the caller's tx.
 */
export class ShipmentFlow {
  private readonly repo: Cradle['fulfilmentRepository'];
  private readonly lazy: Pick<Cradle, 'stockEngine'>;

  constructor(deps: Pick<Cradle, 'fulfilmentRepository' | 'stockEngine'>) {
    this.repo = deps.fulfilmentRepository;
    this.lazy = deps;
  }

  async move(
    tx: Tx,
    s: ShipmentRow,
    to: ShipmentStatus,
    actor: FlowActor,
    action: string,
    o: {
      note?: string | null;
      data?: ShipmentUpdate;
      force?: boolean;
    } = {},
  ): Promise<void> {
    if (s.status === to) return;
    if (o.force !== true && !NEXT[s.status].includes(to))
      throw new ConflictError(`A ${s.status} shipment cannot move to ${to}`, {
        details: { reason: 'TRANSITION_NOT_ALLOWED', from: s.status, to },
      });
    if (o.force !== true && s.holdActive && blockedByHold(s.status, to))
      throw new ConflictError('The order is on hold', { details: { reason: 'ON_HOLD' } });
    const now = new Date();
    const stamp = STAMP[to];
    await this.repo.updateShipment(tx, s.id, {
      status: to,
      ...(stamp === undefined ? {} : { [stamp]: now }),
      ...(o.data ?? {}),
    });
    await this.timeline(tx, s, s.status, to, action, actor, o.note ?? null);
    await this.count(tx, s, to, now);
    await this.publish(tx, s, s.status, to, now);
  }

  /** A new shipment (PENDING_RELEASE): timeline + event + "received" counter. */
  async created(tx: Tx, s: ShipmentRow, actor: FlowActor): Promise<void> {
    await this.timeline(tx, s, null, s.status, 'CREATED', actor, null);
    await this.repo.bumpDaily(tx, s.warehouseId, istDay(new Date()), { received: 1 });
    await this.publish(tx, s, null, s.status, new Date());
  }

  /** A timeline note that is not a status change (hold, allocation, task …). */
  async note(tx: Tx, s: ShipmentRow, action: string, actor: FlowActor, note: string | null) {
    await this.timeline(tx, s, s.status, s.status, action, actor, note);
  }

  /**
   * Gives allocated lots back: unpicked units RESERVED → AVAILABLE, picked / packed units →
   * RETURNED (cancelled after pick; inspection then restocks them). Allocation rows → RELEASED.
   */
  async releaseLots(
    tx: Tx,
    s: Pick<ShipmentRow, 'id' | 'shipmentNo'>,
    rows: readonly AllocationRow[],
    reason: string,
    actor: FlowActor,
  ): Promise<number> {
    const moves: StockMove[] = [];
    let released = 0;
    for (const a of rows) {
      if (a.status === 'RELEASED' || a.status === 'ISSUED') continue;
      const src = { id: a.positionId };
      if (a.status === 'ALLOCATED') {
        if (a.qty - a.pickedQty > 0)
          moves.push({
            type: 'DEALLOCATE',
            from: 'RESERVED',
            to: 'AVAILABLE',
            qty: a.qty - a.pickedQty,
            source: src,
            shipmentId: s.id,
          });
        if (a.pickedQty > 0)
          moves.push({
            type: 'RETURN',
            from: 'PICKED',
            to: 'RETURNED',
            qty: a.pickedQty,
            source: src,
            shipmentId: s.id,
          });
      } else
        moves.push({
          type: 'RETURN',
          from: a.status === 'PICKED' ? 'PICKED' : 'PACKED',
          to: 'RETURNED',
          qty: a.qty,
          source: src,
          shipmentId: s.id,
        });
      await this.repo.updateAllocation(tx, a.id, {
        status: 'RELEASED',
        releasedAt: new Date(),
        releaseReason: reason.slice(0, 200),
        soft: false,
      });
      released += a.qty;
    }
    if (moves.length > 0)
      await this.lazy.stockEngine.apply(tx, moves, {
        commandId: uuidv7(),
        kind: 'DEALLOCATE',
        refType: 'SHIPMENT',
        refId: s.id,
        refNo: s.shipmentNo,
        reason,
        actorUserId: actor.id,
        requestId: actor.requestId ?? null,
        enforce: 'system',
      });
    return released;
  }

  /** Stock moves of a floor action, checked with the person's grants (or as the system). */
  async stock(
    tx: Tx,
    s: Pick<ShipmentRow, 'id' | 'shipmentNo'>,
    moves: readonly StockMove[],
    kind: string,
    actor: FlowActor,
    reason: string | null = null,
    /** Gate-out: inventory learns it from shipment.dispatched (issue), not from a stock delta. */
    silent = false,
  ): Promise<void> {
    if (moves.length === 0) return;
    await this.lazy.stockEngine.apply(tx, moves, {
      commandId: uuidv7(),
      kind,
      refType: 'SHIPMENT',
      refId: s.id,
      refNo: s.shipmentNo,
      reason,
      actorUserId: actor.id,
      requestId: actor.requestId ?? null,
      enforce: actor.access === undefined ? 'system' : { access: actor.access },
      ...(silent ? { silent: true } : {}),
    });
  }

  private async timeline(
    tx: Tx,
    s: ShipmentRow,
    from: ShipmentStatus | null,
    to: ShipmentStatus,
    action: string,
    actor: FlowActor,
    note: string | null,
  ) {
    await this.repo.addEvent(tx, {
      shipmentId: s.id,
      orderId: s.orderId,
      fromStatus: from,
      toStatus: to,
      action: action.slice(0, 40),
      actorType: actor.type,
      actorId: actor.id,
      note: note?.slice(0, 500) ?? null,
    });
  }

  private async count(tx: Tx, s: ShipmentRow, to: ShipmentStatus, now: Date) {
    const inc: Partial<Record<DailyField, number>> & {
      cycleMin?: number;
      pickToPackMin?: number;
      value?: string;
    } = {};
    if (to === 'RELEASED') inc.released = 1;
    if (to === 'DISPATCHED') {
      inc.dispatched = 1;
      if (s.slaDueAt === null || now <= s.slaDueAt) inc.onTimeDispatch = 1;
      const c = minutes(s.releasedAt, now);
      if (c !== undefined) inc.cycleMin = c;
    }
    if (to === 'QC') {
      const p = minutes(s.pickStartedAt, now);
      if (p !== undefined) {
        inc.pickToPackMin = p;
        inc.pickToPackCount = 1;
      }
    }
    if (to === 'DELIVERED') inc.delivered = 1;
    if (to === 'FULFILLED') {
      inc.fulfilled = 1;
      inc.value = s.value.toFixed(2);
    }
    if (to === 'CANCELLED') inc.cancelled = 1;
    if (Object.keys(inc).length > 0) await this.repo.bumpDaily(tx, s.warehouseId, istDay(now), inc);
  }

  private async publish(
    tx: Tx,
    s: ShipmentRow,
    from: ShipmentStatus | null,
    to: ShipmentStatus,
    at: Date,
  ) {
    const [snap, order] = await Promise.all([
      this.repo.orderSnapshot(s.orderId, tx),
      this.repo.order(s.orderId, tx),
    ]);
    await emitWarehouseEvent(
      tx,
      'shipment.status_changed.v1',
      {
        shipmentId: s.id,
        shipmentNo: s.shipmentNo,
        orderId: s.orderId,
        orderNo: order?.orderNo ?? '',
        warehouseId: s.warehouseId,
        from: from,
        to: to,
        at: at.toISOString(),
        orderShipments: snap.map((x) => ({
          shipmentId: x.id,
          warehouseId: x.warehouseId,
          status: x.id === s.id ? to : x.status,
          version: x.version,
          deliveredLines: x.lines
            .filter((l) => l.deliveredQty > 0 && l.orderLineNo !== null)
            .map((l) => ({
              lineNo: l.orderLineNo ?? 0,
              variantId: l.variantId,
              qty: l.deliveredQty,
            })),
        })),
      },
      s.orderId,
    );
  }
}
