import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import {
  INVENTORY_EVENTS,
  type OrderPaidV1,
  type OrderStockReleaseV1,
  type ShipmentDispatchedV1,
} from '@farmx/infra/events';
import { type RoutingDecision, evaluateRouting } from '@farmx/infra/routing';
import type { Cradle } from '@fastify/awilix';

import { emitInventoryEvent } from '../../adapters/events.js';
import { requestHash } from '../../middleware/http.js';
import type { Actor } from '../audit/index.js';
import { type StockMove, byLockOrder } from '../stock/index.js';
import { type AllocationPlan, planAllocation } from './reservations.allocation.js';
import type {
  AvailabilityCheckInput,
  ReservationListQuery,
  ReservationView,
  ReserveInput,
  ReserveLineInput,
} from './reservations.types.js';

type Deps = Pick<
  Cradle,
  | 'reservationsRepository'
  | 'runInTransaction'
  | 'stockService'
  | 'warehousesService'
  | 'projectionsService'
  | 'settingsService'
  | 'auditService'
  | 'ordersClient'
  | 'logger'
>;

export interface ReserveResult {
  reservation: ReservationView;
  /** Same Idempotency-Key as an earlier call: nothing was held again. */
  replayed: boolean;
  split: boolean;
}

/** Event context: correlation (request) id + the causing event id. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
}

const EXPIRY_BATCH = 200;
const EXPIRY_MAX_BATCHES = 10;
const ORPHAN_AGE_MS = 60 * 60_000;
const ORPHAN_BATCH = 200;
const RELEASABLE_ORDER_STATUSES = new Set(['FAILED', 'REJECTED', 'CANCELLED']);
const LIVE_STATUSES = new Set(['ACTIVE', 'COMMITTED', 'ISSUED']);

const orderAlreadyReserved = (orderRef: string) =>
  new ConflictError('This order already holds a live reservation', {
    details: { reason: 'ORDER_ALREADY_RESERVED', orderRef },
  });

/** Thrown inside the reserve transaction to roll it back. */
class RaceLost extends Error {}
class KeyTaken extends Error {}
class OrderRefTaken extends Error {}

const insufficient = (plan: Extract<AllocationPlan, { ok: false }>) =>
  new ConflictError('Not enough stock for this order at the serving warehouses', {
    details: { reason: 'INSUFFICIENT_STOCK', shortfall: plan.shortfall },
  });

const heldMoves = (r: ReservationView): StockMove[] =>
  r.lines
    .filter((l) => l.heldQty > 0)
    .map((l) => ({ warehouseId: l.warehouseId, variantId: l.variantId, qty: l.heldQty }));

/**
 * Atomic stock reservations (D-33, D-36):
 *   reserve (ACTIVE, payment window) → commit on order.paid (no expiry) → issue at dispatch (F1)
 *   release on order.rejected / cancelled / failed (full or per line) · expiry job for ACTIVE
 * Every change locks the reservation row first; stock rows are then touched in lock order.
 */
export class ReservationsService {
  constructor(private readonly deps: Deps) {}

  // ── Reserve (internal API, order-service checkout) ──

  async reserve(key: string, input: ReserveInput): Promise<ReserveResult> {
    const hash = requestHash(input);
    const earlier = await this.replay(key, hash);
    if (earlier !== null) return earlier;

    const settings = await this.deps.settingsService.current();
    if (input.lines.length > settings.maxReservationLines)
      throw new ValidationError([
        {
          path: 'body.lines',
          message: `at most ${String(settings.maxReservationLines)} lines per reservation`,
        },
      ]);
    const ttlSeconds = input.ttlSeconds ?? settings.reservationTtlSeconds;
    // Fast, friendly check; the partial unique index on orderRef is the real guard.
    const live = (await this.deps.reservationsRepository.byOrderRef(input.orderRef)).some((r) =>
      LIVE_STATUSES.has(r.status),
    );
    if (live) throw orderAlreadyReserved(input.orderRef);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const plan = await this.plan(
        input.pinCode,
        input.lines,
        settings.allowSplitAllocation,
        input.routing,
      );
      if (!plan.ok) throw insufficient(plan);
      try {
        const reservation = await this.deps.runInTransaction(async (tx) => {
          const created = await this.deps.reservationsRepository.create(tx, {
            orderRef: input.orderRef,
            idempotencyKey: key,
            requestHash: hash,
            pinCode: input.pinCode,
            expiresAt: new Date(Date.now() + ttlSeconds * 1000),
            lines: plan.allocations,
          });
          if (!created.ok)
            throw created.conflict === 'IDEMPOTENCY_KEY' ? new KeyTaken() : new OrderRefTaken();
          if (!(await this.deps.stockService.holdAllInTx(tx, plan.allocations)))
            throw new RaceLost();
          return created.view;
        });
        return { reservation, replayed: false, split: plan.split };
      } catch (error) {
        if (error instanceof RaceLost) continue; // someone took the stock: re-plan once
        if (error instanceof KeyTaken) {
          const raced = await this.replay(key, hash);
          if (raced !== null) return raced;
        }
        if (error instanceof OrderRefTaken) throw orderAlreadyReserved(input.orderRef);
        throw error;
      }
    }
    throw new ConflictError('Stock changed while reserving; not enough left', {
      details: { reason: 'INSUFFICIENT_STOCK', shortfall: [] },
    });
  }

  /** Dry-run allocation for checkout screens: nothing is held. */
  async checkAvailability(input: AvailabilityCheckInput) {
    const { allowSplitAllocation } = await this.deps.settingsService.current();
    const plan = await this.plan(input.pinCode, input.lines, allowSplitAllocation, input.routing);
    const trace =
      plan.routing === undefined
        ? null
        : {
            ruleId: plan.routing.ruleId,
            ruleName: plan.routing.ruleName,
            fallbackUsed: plan.routing.fallbackUsed,
            ordered: plan.routing.ordered,
            steps: plan.routing.trace,
          };
    return plan.ok
      ? {
          fulfillable: true,
          split: plan.split,
          allocations: plan.allocations,
          shortfall: [],
          routing: trace,
        }
      : {
          fulfillable: false,
          split: false,
          allocations: [],
          shortfall: plan.shortfall,
          routing: trace,
        };
  }

  // ── Commit (order.paid) ──

  async commitInTx(tx: Tx, data: OrderPaidV1, ctx: EventContext): Promise<void> {
    const r = await this.lockForOrder(tx, data.reservationId, data.orderId);
    if (r === null) return;
    const emitCommitted = (recovered: boolean) =>
      emitInventoryEvent(
        tx,
        INVENTORY_EVENTS.reservationCommitted,
        { reservationId: r.id, orderRef: r.orderRef, recovered, lines: committedLines(r) },
        ctx.correlationId,
        ctx.causationId,
      );

    switch (r.status) {
      case 'ACTIVE':
        await this.deps.reservationsRepository.update(tx, r.id, {
          status: 'COMMITTED',
          committedAt: new Date(),
          paymentRef: data.paymentId,
        });
        return emitCommitted(false);
      case 'COMMITTED':
      case 'ISSUED':
        return emitCommitted(r.recoveredFromExpiry); // duplicate / re-sent: answer again
      case 'EXPIRED':
        return this.recoverInTx(tx, r, data, ctx);
      case 'REJECTED':
      case 'RELEASED':
        // Stock is not held for this order any more: the order side refunds (docs/oms R5).
        return this.emitRejected(tx, r, [], ctx);
    }
  }

  /** Late payment: re-secure the same lines from sellable stock, all or nothing (savepoint). */
  private async recoverInTx(
    tx: Tx,
    r: ReservationView,
    data: OrderPaidV1,
    ctx: EventContext,
  ): Promise<void> {
    // Expired lines hold nothing now; re-secure what was open when it expired.
    const moves = r.lines
      .map((l) => ({
        warehouseId: l.warehouseId,
        variantId: l.variantId,
        qty: l.qty - l.releasedQty - l.issuedQty,
      }))
      .filter((m) => m.qty > 0);
    await tx.$executeRaw`SAVEPOINT reservation_recovery`;
    if (await this.deps.stockService.holdAllInTx(tx, moves)) {
      await tx.$executeRaw`RELEASE SAVEPOINT reservation_recovery`;
      await this.deps.reservationsRepository.update(tx, r.id, {
        status: 'COMMITTED',
        committedAt: new Date(),
        paymentRef: data.paymentId,
        recoveredFromExpiry: true,
      });
      await emitInventoryEvent(
        tx,
        INVENTORY_EVENTS.reservationCommitted,
        { reservationId: r.id, orderRef: r.orderRef, recovered: true, lines: moves },
        ctx.correlationId,
        ctx.causationId,
      );
      return;
    }
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT reservation_recovery`;
    const available = await this.deps.stockService.sellableMap(
      [...new Set(moves.map((m) => m.warehouseId))],
      moves.map((m) => m.variantId),
    );
    const shortfall = moves
      .filter((m) => (available.get(`${m.warehouseId}|${m.variantId}`) ?? 0) < m.qty)
      .map((m) => ({
        variantId: m.variantId,
        requested: m.qty,
        available: available.get(`${m.warehouseId}|${m.variantId}`) ?? 0,
      }));
    await this.deps.reservationsRepository.update(tx, r.id, {
      status: 'REJECTED',
      rejectedAt: new Date(),
      paymentRef: data.paymentId,
    });
    await this.emitRejected(tx, r, shortfall, ctx);
  }

  private emitRejected(
    tx: Tx,
    r: ReservationView,
    shortfall: { variantId: string; requested: number; available: number }[],
    ctx: EventContext,
  ): Promise<void> {
    return emitInventoryEvent(
      tx,
      INVENTORY_EVENTS.reservationRejected,
      { reservationId: r.id, orderRef: r.orderRef, shortfall },
      ctx.correlationId,
      ctx.causationId,
    );
  }

  // ── Release (order.rejected / cancelled / failed, admin, orphan sweep) ──

  async releaseInTx(
    tx: Tx,
    data: OrderStockReleaseV1,
    ctx: EventContext,
    by: { userId: string | null; reason: string },
  ): Promise<void> {
    const r = await this.lockForOrder(tx, data.reservationId, data.orderId);
    if (r === null) return;
    const emitReleased = (
      scope: 'FULL' | 'PARTIAL',
      lines: { variantId: string; qty: number; warehouseId: string }[],
    ) =>
      emitInventoryEvent(
        tx,
        INVENTORY_EVENTS.reservationReleased,
        { reservationId: r.id, orderRef: r.orderRef, scope, lines },
        ctx.correlationId,
        ctx.causationId,
      );

    if (r.status === 'ISSUED') {
      this.deps.logger.error(
        { reservationId: r.id, orderRef: r.orderRef },
        'release requested for issued stock (goods left the warehouse); ignored — returns flow',
      );
      return;
    }
    if (r.status === 'RELEASED' || r.status === 'REJECTED') return emitReleased('FULL', []);
    if (r.status === 'EXPIRED') {
      await this.deps.reservationsRepository.update(tx, r.id, {
        status: 'RELEASED',
        releasedAt: new Date(),
        releaseReason: by.reason.slice(0, 500),
        releasedByUserId: by.userId,
      });
      return emitReleased('FULL', []);
    }

    // ACTIVE or COMMITTED: give the held units back.
    const moves = data.scope === 'FULL' ? heldMoves(r) : partialMoves(r, data.lines);
    await this.deps.stockService.releaseAllInTx(tx, moves);
    await this.deps.reservationsRepository.addReleased(tx, r.id, moves);
    const stillHeld = r.lines.reduce((n, l) => n + l.heldQty, 0) - sumQty(moves);
    if (stillHeld <= 0)
      await this.deps.reservationsRepository.update(tx, r.id, {
        status: 'RELEASED',
        releasedAt: new Date(),
        releaseReason: by.reason.slice(0, 500),
        releasedByUserId: by.userId,
      });
    else await this.deps.reservationsRepository.update(tx, r.id, {});
    await emitReleased(stillHeld <= 0 ? 'FULL' : 'PARTIAL', byWarehouseVariantQty(moves));
  }

  /** Admin force release (stuck order, data repair). Audited; emits reservation_released. */
  async adminRelease(actor: Actor, id: string, reason: string): Promise<ReservationView> {
    return this.deps.runInTransaction(async (tx) => {
      const r = await this.deps.reservationsRepository.find(id, tx);
      if (r === null) throw new NotFoundError('Reservation');
      if (!['ACTIVE', 'COMMITTED', 'EXPIRED'].includes(r.status))
        throw new ConflictError(`Reservation is ${r.status}`, {
          details: { reason: 'NOT_RELEASABLE', status: r.status },
        });
      await this.releaseInTx(
        tx,
        {
          orderId: r.orderRef,
          orderNo: '',
          reservationId: r.id,
          scope: 'FULL',
          lines: [],
          reasonCode: 'ADMIN_RELEASE',
        },
        { correlationId: actor.requestId ?? `admin:${id}` },
        { userId: actor.userId, reason },
      );
      await this.deps.auditService.record(tx, actor, {
        action: 'reservation.release',
        targetType: 'reservation',
        targetId: id,
        before: { status: r.status },
        after: { status: 'RELEASED' },
        reason,
      });
      const after = await this.deps.reservationsRepository.find(id, tx);
      if (after === null) throw new NotFoundError('Reservation');
      return after;
    });
  }

  // ── Background jobs ──

  /** ACTIVE past expiresAt → EXPIRED (stock freed). Safe on many workers (SKIP LOCKED). */
  async expireDue(): Promise<{ expired: number }> {
    let expired = 0;
    for (let batch = 0; batch < EXPIRY_MAX_BATCHES; batch += 1) {
      const n = await this.deps.runInTransaction(async (tx) => {
        const repo = this.deps.reservationsRepository;
        const due = await repo.lockDue(tx, EXPIRY_BATCH);
        if (due.length === 0) return 0;
        const ids = due.map((d) => d.id);
        const held = await repo.heldLines(tx, ids);
        await this.deps.stockService.releaseAllInTx(tx, aggregate(held));
        await repo.markExpired(tx, ids);
        for (const d of due)
          await emitInventoryEvent(
            tx,
            INVENTORY_EVENTS.reservationExpired,
            { reservationId: d.id, orderRef: d.orderRef },
            `expiry:${d.id}`,
          );
        return due.length;
      });
      expired += n;
      if (n < EXPIRY_BATCH) break;
    }
    if (expired > 0) this.deps.logger.info({ expired }, 'reservations expired');
    return { expired };
  }

  /**
   * Nightly safety net: live reservations (> 1 h old) whose order is already terminal
   * (FAILED / REJECTED / CANCELLED) are released. order-service unreachable → skip this run.
   */
  async orphanSweep(): Promise<{ checked: number; released: number }> {
    const stale = await this.deps.reservationsRepository.staleLive(
      new Date(Date.now() - ORPHAN_AGE_MS),
      ORPHAN_BATCH,
    );
    const statuses = await this.deps.ordersClient.statuses([
      ...new Set(stale.map((s) => s.orderRef)),
    ]);
    if (statuses === null) return { checked: 0, released: 0 };
    const terminal = new Set(
      statuses.filter((s) => RELEASABLE_ORDER_STATUSES.has(s.status)).map((s) => s.id),
    );
    let released = 0;
    for (const s of stale.filter((x) => terminal.has(x.orderRef))) {
      await this.deps.runInTransaction((tx) =>
        this.releaseInTx(
          tx,
          {
            orderId: s.orderRef,
            orderNo: '',
            reservationId: s.id,
            scope: 'FULL',
            lines: [],
            reasonCode: 'ORPHAN_SWEEP',
          },
          { correlationId: `orphan-sweep:${s.id}` },
          { userId: null, reason: 'Orphan sweep: order is terminal' },
        ),
      );
      released += 1;
    }
    if (released > 0) this.deps.logger.warn({ released }, 'orphan reservations released');
    return { checked: stale.length, released };
  }

  /**
   * D-57b §2a.11 issue at dispatch: against the order's ONE reservation, line (warehouse, SKU)
   * as it is now, under the reservation lock. Guard: issued + qty ≤ qty − released; a line that
   * fails is not applied and `inventory.issue_rejected.v1` tells the WMS (ISSUE_MISMATCH).
   * Idempotent per `dispatchId` (ledger reference). All lines issued → reservation ISSUED.
   */
  async issueInTx(tx: Tx, d: ShipmentDispatchedV1, ctx: EventContext): Promise<void> {
    const r = await this.lockForOrder(tx, null, d.orderId);
    if (r === null) return;
    if (await this.deps.stockService.wasIssued(tx, d.dispatchId)) return; // republished dispatch
    if (r.status !== 'COMMITTED' && r.status !== 'ISSUED') {
      this.deps.logger.error(
        { reservationId: r.id, status: r.status, dispatchId: d.dispatchId },
        'dispatch for a reservation that is not committed',
      );
      return;
    }
    const ok: { variantId: string; qty: number }[] = [];
    const bad: { variantId: string; requested: number; held: number }[] = [];
    for (const l of d.lines) {
      const line = r.lines.find(
        (x) => x.warehouseId === d.warehouseId && x.variantId === l.variantId,
      );
      const left = line === undefined ? 0 : line.qty - line.releasedQty - line.issuedQty;
      if (l.qty > left) bad.push({ variantId: l.variantId, requested: l.qty, held: left });
      else ok.push(l);
    }
    if (
      ok.length > 0 &&
      (await this.deps.stockService.issueInTx(tx, d.dispatchId, d.warehouseId, ok))
    ) {
      await this.deps.reservationsRepository.addIssued(
        tx,
        r.id,
        ok.map((l) => ({ ...l, warehouseId: d.warehouseId })),
      );
      const after = await this.deps.reservationsRepository.find(r.id, tx);
      const open = (after?.lines ?? []).some((l) => l.qty - l.releasedQty - l.issuedQty > 0);
      await this.deps.reservationsRepository.update(
        tx,
        r.id,
        open ? {} : { status: 'ISSUED', issuedAt: new Date() },
      );
    }
    if (bad.length > 0) {
      this.deps.logger.error(
        { dispatchId: d.dispatchId, lines: bad },
        'dispatch over-issue refused',
      );
      await emitInventoryEvent(
        tx,
        INVENTORY_EVENTS.issueRejected,
        {
          dispatchId: d.dispatchId,
          shipmentId: d.shipmentId,
          orderRef: d.orderId,
          warehouseId: d.warehouseId,
          lines: bad,
        },
        ctx.correlationId,
        ctx.causationId,
      );
    }
  }

  // ── D-57b: warehouse reallocation (§2a.4) + allocation reconcile (§2a.3) ──

  /**
   * Moves held quantity of some SKUs between warehouses inside ONE reservation (the order keeps
   * one reservation, §2a.11). All or nothing: the source must hold it, the target must have it
   * free (safety stock respected); otherwise 409 and nothing changes. Idempotent by `key`
   * (the warehouse reallocation id): a retry returns the stored result.
   */
  async reallocate(
    id: string,
    key: string,
    moves: readonly {
      variantId: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      qty: number;
    }[],
  ) {
    const repo = this.deps.reservationsRepository;
    const done = await repo.reallocation(key);
    if (done !== null) return { ...(done.result as object), replayed: true };
    if (moves.some((m) => m.fromWarehouseId === m.toWarehouseId))
      throw new ValidationError([{ path: 'body.moves', message: 'source and target must differ' }]);
    try {
      return await this.deps.runInTransaction(async (tx) => {
        const r = await repo.lock(tx, id);
        if (r === null) throw new NotFoundError('Reservation');
        if (r.status !== 'ACTIVE' && r.status !== 'COMMITTED')
          throw new ConflictError(`Reservation is ${r.status}`, {
            details: { reason: 'NOT_REALLOCATABLE', status: r.status },
          });
        for (const m of moves) {
          const line = r.lines.find(
            (l) => l.warehouseId === m.fromWarehouseId && l.variantId === m.variantId,
          );
          if (line === undefined || line.heldQty < m.qty)
            throw new ConflictError('The source warehouse does not hold that quantity', {
              details: { reason: 'NOT_HELD', variantId: m.variantId, held: line?.heldQty ?? 0 },
            });
        }
        await this.deps.stockService.releaseAllInTx(
          tx,
          moves.map((m) => ({
            warehouseId: m.fromWarehouseId,
            variantId: m.variantId,
            qty: m.qty,
          })),
        );
        const held = await this.deps.stockService.holdAllInTx(
          tx,
          moves.map((m) => ({ warehouseId: m.toWarehouseId, variantId: m.variantId, qty: m.qty })),
        );
        if (!held)
          throw new ConflictError('Not enough free stock at the target warehouse', {
            details: { reason: 'INSUFFICIENT_STOCK' },
          });
        for (const m of moves) {
          const fresh = (await repo.find(id, tx))?.lines.find(
            (l) => l.warehouseId === m.fromWarehouseId && l.variantId === m.variantId,
          );
          await repo.moveLine(tx, id, m, fresh ?? { qty: m.qty, releasedQty: 0, issuedQty: 0 });
        }
        const after = await repo.find(id, tx);
        const result = {
          reservationId: id,
          orderRef: r.orderRef,
          lines: (after?.lines ?? []).map((l) => ({
            warehouseId: l.warehouseId,
            variantId: l.variantId,
            qty: l.qty,
            heldQty: l.heldQty,
          })),
          moved: moves,
        };
        await repo.saveReallocation(tx, key, id, result);
        return { ...result, replayed: false };
      });
    } catch (err) {
      const raced = await repo.reallocation(key);
      if (raced !== null) return { ...(raced.result as object), replayed: true };
      throw err;
    }
  }

  /** Held lines of live reservations at a warehouse (WMS allocation reconcile), keyset paged. */
  async openLines(warehouseId: string, cursor: string | undefined, limit: number) {
    let after: { reservationId: string; variantId: string } | null = null;
    if (cursor !== undefined) {
      const [reservationId, variantId] = cursor.split(':');
      if (reservationId === undefined || variantId === undefined)
        throw new ValidationError([{ path: 'querystring.cursor', message: 'invalid cursor' }]);
      after = { reservationId, variantId };
    }
    const rows = await this.deps.reservationsRepository.openLines(warehouseId, after, limit);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? `${last.reservationId}:${last.variantId}`
          : null,
    };
  }

  // ── Reads ──

  async get(id: string): Promise<ReservationView> {
    const r = await this.deps.reservationsRepository.find(id);
    if (r === null) throw new NotFoundError('Reservation');
    return r;
  }

  byOrderRef(orderRef: string): Promise<ReservationView[]> {
    return this.deps.reservationsRepository.byOrderRef(orderRef);
  }

  list(query: ReservationListQuery): Promise<Paginated<ReservationView>> {
    return this.deps.reservationsRepository.list(query);
  }

  // ── Helpers ──

  private async replay(key: string, hash: string): Promise<ReserveResult | null> {
    const existing = await this.deps.reservationsRepository.findByKey(key);
    if (existing === null) return null;
    if (existing.requestHash !== hash)
      throw new ValidationError(
        [{ path: 'headers.idempotency-key', message: 'already used for a different request' }],
        'Idempotency-Key reused with a different request',
      );
    const reservation = existing.view;
    return {
      reservation,
      replayed: true,
      split: new Set(reservation.lines.map((l) => l.warehouseId)).size > 1,
    };
  }

  private async plan(
    pinCode: string,
    lines: readonly ReserveLineInput[],
    allowSplit: boolean,
    routing?: ReserveInput['routing'],
  ): Promise<AllocationPlan & { routing?: RoutingDecision }> {
    const [variants, coverage, snapshot] = await Promise.all([
      this.deps.projectionsService.requireActive(
        lines.map((l) => l.variantId),
        (i) => `body.lines[${String(i)}].variantId`,
      ),
      this.deps.warehousesService.candidatesForPin(pinCode),
      this.deps.settingsService.routingSnapshot(),
    ]);
    if (coverage.length === 0)
      throw new ConflictError('No warehouse serves this PIN code', {
        details: { reason: 'NOT_SERVICEABLE', pinCode },
      });
    const sellable = await this.deps.stockService.sellableMap(
      coverage.map((c) => c.warehouseId),
      lines.map((l) => l.variantId),
    );
    const at = (w: string, v: string) => sellable.get(`${w}|${v}`) ?? 0;
    // D-57b W3.12: routing rules reorder the PIN's warehouses (coverage order otherwise).
    let candidates = coverage;
    let decision: RoutingDecision | undefined;
    if (snapshot !== null && snapshot.rules.length > 0) {
      const facts = lines.map((l) => variants.get(l.variantId));
      decision = evaluateRouting(
        snapshot.rules,
        snapshot.fallback,
        {
          pinCode,
          stateCode: routing?.stateCode ?? null,
          district: routing?.district ?? null,
          value: routing?.orderValue ?? null,
          weightKg: lines.reduce((n, l, i) => n + ((facts[i]?.weightGrams ?? 0) * l.qty) / 1000, 0),
          categoryIds: facts.flatMap((f) => (f?.rootCategoryId == null ? [] : [f.rootCategoryId])),
          coldRequired: facts.some((f) => f?.coldChain === true),
          temperatureClasses: [
            ...new Set(facts.flatMap((f) => (f === undefined ? [] : [f.temperatureClass]))),
          ],
          hazardous: false,
          lat: routing?.lat ?? null,
          lng: routing?.lng ?? null,
        },
        coverage.map((c, i) => ({
          warehouseId: c.warehouseId,
          type: c.type === 'MOTHER' ? 'MOTHER' : 'DEPOT',
          lat: c.lat,
          lng: c.lng,
          priority: i,
          covered: true,
          routable: true,
          throttled: snapshot.throttles.some(
            (t) => t.warehouseId === c.warehouseId && (t.paused || t.capReached === true),
          ),
          coldChain: c.hasColdChain,
          fullStock: lines.every((l) => at(c.warehouseId, l.variantId) >= l.qty),
          stockUnits: lines.reduce((n, l) => n + at(c.warehouseId, l.variantId), 0),
          equipment: [],
          dispatchWithinHours: null,
        })),
      );
      const rank = new Map(decision.ordered.map((id, i) => [id, i]));
      candidates = [...coverage].sort(
        (a, b) =>
          (rank.get(a.warehouseId) ?? 1_000 + coverage.indexOf(a)) -
          (rank.get(b.warehouseId) ?? 1_000 + coverage.indexOf(b)),
      );
    }
    const plan = planAllocation(
      lines.map((l) => ({
        variantId: l.variantId,
        qty: l.qty,
        coldChain: variants.get(l.variantId)?.coldChain ?? false,
      })),
      candidates,
      at,
      allowSplit,
    );
    return decision === undefined ? plan : { ...plan, routing: decision };
  }

  /** The reservation an order event refers to (by id, else the newest for that order), locked. */
  private async lockForOrder(
    tx: Tx,
    reservationId: string | null,
    orderId: string,
  ): Promise<ReservationView | null> {
    const repo = this.deps.reservationsRepository;
    const id = reservationId ?? (await repo.byOrderRef(orderId, tx))[0]?.id;
    if (id === undefined) {
      this.deps.logger.warn({ orderId }, 'order event for an order without a reservation; ignored');
      return null;
    }
    const r = await repo.lock(tx, id);
    if (r?.orderRef !== orderId) {
      this.deps.logger.error(
        { orderId, reservationId: id },
        'reservation / order mismatch; ignored',
      );
      return null;
    }
    return r;
  }
}

const sumQty = (moves: readonly { qty: number }[]): number => moves.reduce((n, m) => n + m.qty, 0);

/** Released units per (warehouse, variant): the warehouse read model needs the node (D-56). */
const byWarehouseVariantQty = (
  moves: readonly StockMove[],
): { variantId: string; qty: number; warehouseId: string }[] => {
  const m = new Map<string, { variantId: string; qty: number; warehouseId: string }>();
  for (const x of moves) {
    const k = `${x.warehouseId}|${x.variantId}`;
    const cur = m.get(k);
    m.set(k, { warehouseId: x.warehouseId, variantId: x.variantId, qty: (cur?.qty ?? 0) + x.qty });
  }
  return [...m.values()];
};

/** What the order holds per warehouse once committed (issued units still belong to it). */
const committedLines = (r: ReservationView): StockMove[] =>
  r.lines
    .map((l) => ({
      warehouseId: l.warehouseId,
      variantId: l.variantId,
      qty: l.qty - l.releasedQty,
    }))
    .filter((l) => l.qty > 0);

const aggregate = (rows: readonly { warehouseId: string; variantId: string; held: number }[]) => {
  const m = new Map<string, StockMove>();
  for (const r of rows) {
    const k = `${r.warehouseId}|${r.variantId}`;
    const cur = m.get(k);
    m.set(k, {
      warehouseId: r.warehouseId,
      variantId: r.variantId,
      qty: (cur?.qty ?? 0) + r.held,
    });
  }
  return [...m.values()].sort(byLockOrder);
};

/**
 * Partial release of `qty` units per variant: from that variant's lines with the smallest held
 * quantity first (frees whole warehouse shipments first), capped at what is still held.
 */
const partialMoves = (
  r: ReservationView,
  lines: readonly { variantId: string; qty: number }[],
): StockMove[] => {
  const moves: StockMove[] = [];
  for (const want of lines) {
    let remaining = want.qty;
    const held = r.lines
      .filter((l) => l.variantId === want.variantId && l.heldQty > 0)
      .sort((a, b) => a.heldQty - b.heldQty || (a.warehouseId < b.warehouseId ? -1 : 1));
    for (const l of held) {
      if (remaining <= 0) break;
      const take = Math.min(l.heldQty, remaining);
      moves.push({ warehouseId: l.warehouseId, variantId: l.variantId, qty: take });
      remaining -= take;
    }
  }
  return moves;
};
