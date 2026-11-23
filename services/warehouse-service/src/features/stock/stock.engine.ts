import { AppError, ConflictError, ErrorCode, ForbiddenError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';
import { emitWarehouseEvent } from '../../adapters/events.js';
import type { Access } from '../../middleware/access.js';
import type { MovementInsert, PositionDims, PositionRow } from './stock.repository.js';
import {
  COLUMN,
  type Column,
  type Quantities,
  type StockStatus,
  type WritesMode,
  inventoryDeltas,
  isColumn,
} from './stock.rules.js';

export type MovementType = MovementInsert['type'];

/** An existing position, or the dimensions of one (created when missing). */
export type PositionRef = { id: string } | (PositionDims & { reviewFields?: string[] });

/**
 * One quantity move. A status that is a column (AVAILABLE, QC_HOLD …) needs a position on that
 * side; RECEIVED / IN_TRANSIT / DISPATCHED / DELIVERED / WRITTEN_OFF are outside the warehouse.
 * `target` defaults to `source` (a status change in place).
 */
export interface StockMove {
  type: MovementType;
  from: StockStatus;
  to: StockStatus;
  qty: number;
  source?: PositionRef;
  target?: PositionRef;
  shipmentId?: string | null;
}

export interface ApplyContext {
  /** One id per command: the inventory event's movementId. */
  commandId: string;
  /** Event `kind` for inventory's ledger. */
  kind: string;
  refType: string;
  refId: string | null;
  refNo: string | null;
  reason: string | null;
  actorUserId: string | null;
  requestId: string | null;
  /**
   * Lifecycle check of status changes: `access` = a person (system-only moves refused, the
   * transition's permission required at the warehouse); `system` = jobs / flows; `none` = data
   * corrections that are not status changes (adjustments, owner fix, relabel, opening import).
   */
  enforce: { access: Access } | 'system' | 'none';
  /** Writes modes in which this command may run (default WMS only). */
  modes?: readonly WritesMode[];
}

export interface ApplyResult {
  movements: number;
  /** warehouse → variant → inventory deltas. */
  deltas: Map<string, Map<string, { sellable: number; damaged: number }>>;
  positionIds: string[];
}

const frozen = (mode: WritesMode) =>
  new AppError(
    ErrorCode.CONFLICT,
    mode === 'FROZEN'
      ? 'Stock writes are frozen for the inventory → warehouse cutover'
      : 'Stock is still managed by inventory-service (cutover not done)',
    423,
    { details: { reason: mode === 'FROZEN' ? 'STOCK_WRITES_FROZEN' : 'STOCK_NOT_CUTOVER' } },
  );

const OUT_OF_WAREHOUSE: ReadonlySet<StockStatus> = new Set(['IN_TRANSIT']);

/**
 * THE stock write path (D-57a). One call = one command inside the caller's transaction:
 * lock positions (id order) → lifecycle + quantity checks → positions, summary, ledger, unit QR →
 * `warehouse.stock_changed.v1` for inventory. Callers write their audit row in the same tx.
 */
export class StockEngine {
  private readonly repo: Cradle['stockRepository'];
  private readonly lazy: Pick<Cradle, 'stockSettings'>;
  private transitionCache: { at: number; rows: Map<string, TransitionRow> } | undefined;

  constructor(deps: Pick<Cradle, 'stockRepository' | 'stockSettings'>) {
    this.repo = deps.stockRepository;
    this.lazy = deps;
  }

  /** Lifecycle rows, cached 30 s per process (approved changes call `invalidate`). */
  async transitions(): Promise<Map<string, TransitionRow>> {
    if (this.transitionCache !== undefined && Date.now() - this.transitionCache.at < 30_000)
      return this.transitionCache.rows;
    const rows = await this.repo.transitions();
    const map = new Map(rows.map((r) => [`${r.fromStatus}>${r.toStatus}`, r]));
    this.transitionCache = { at: Date.now(), rows: map };
    return map;
  }

  invalidate(): void {
    this.transitionCache = undefined;
  }

  async apply(tx: Tx, moves: readonly StockMove[], ctx: ApplyContext): Promise<ApplyResult> {
    const mode = await this.lazy.stockSettings.writesMode(tx);
    if (!(ctx.modes ?? ['WMS']).includes(mode)) throw frozen(mode);
    for (const m of moves)
      if (!Number.isInteger(m.qty) || m.qty <= 0) throw new Error('stock move qty must be > 0');

    // 1. Resolve dimension refs to position ids, then lock every position in id order.
    const batchIds = new Set<string>();
    for (const m of moves)
      for (const ref of [m.source, m.target])
        if (ref !== undefined && !('id' in ref)) batchIds.add(ref.batchId);
    const batchMap = new Map((await this.repo.batches([...batchIds], tx)).map((b) => [b.id, b]));
    const resolved = new Map<PositionRef, string>();
    for (const m of moves)
      for (const ref of [m.source, m.target]) {
        if (ref === undefined || resolved.has(ref)) continue;
        if ('id' in ref) resolved.set(ref, ref.id);
        else
          resolved.set(
            ref,
            await this.repo.ensurePosition(tx, ref, {
              expiryDate: batchMap.get(ref.batchId)?.expiryDate ?? null,
              ...(ref.reviewFields === undefined ? {} : { reviewFields: ref.reviewFields }),
            }),
          );
      }
    const locked = await this.repo.lockPositions(tx, [...resolved.values()]);
    const pos = new Map(locked.map((p) => [p.id, p]));
    const need = (ref: PositionRef | undefined, side: string): PositionRow => {
      const id = ref === undefined ? undefined : resolved.get(ref);
      const p = id === undefined ? undefined : pos.get(id);
      if (p === undefined) throw new Error(`stock move needs a ${side} position`);
      return p;
    };

    // 2. Lifecycle + permission checks.
    const table = await this.transitions();
    for (const m of moves) {
      if (m.from === m.to || ctx.enforce === 'none') continue;
      const t = table.get(`${m.from}>${m.to}`);
      if (!t?.isActive)
        throw new ConflictError(`Stock cannot move from ${m.from} to ${m.to}`, {
          details: { reason: 'TRANSITION_NOT_ALLOWED', from: m.from, to: m.to },
        });
      if (ctx.enforce === 'system') continue;
      const wh = (
        isColumn(m.from) ? need(m.source, 'source') : need(m.target ?? m.source, 'target')
      ).warehouseId;
      if (t.systemOnly || t.permissionKey === null)
        throw new ForbiddenError(`${m.from} → ${m.to} is done by the system only`);
      if (!ctx.enforce.access.can(t.permissionKey, wh)) throw new ForbiddenError();
    }

    // 3. Running balances, deltas, ledger rows.
    const balance = new Map(locked.map((p) => [p.id, { ...p }]));
    const posDelta = new Map<string, Partial<Record<Column, number>>>();
    const sumDelta = new Map<string, { d: Partial<Record<Column, number>>; unknown: number }>();
    const inv: ApplyResult['deltas'] = new Map();
    const ledger: MovementInsert[] = [];
    const bump = (p: PositionRow, status: StockStatus, n: number) => {
      const col = COLUMN[status as keyof typeof COLUMN];
      const pd = posDelta.get(p.id) ?? {};
      pd[col] = (pd[col] ?? 0) + n;
      posDelta.set(p.id, pd);
      const key = `${p.warehouseId}|${p.variantId}`;
      const sd = sumDelta.get(key) ?? { d: {}, unknown: 0 };
      sd.d[col] = (sd.d[col] ?? 0) + n;
      if (p.expiryDate === null) sd.unknown += n;
      sumDelta.set(key, sd);
      const bal = balance.get(p.id);
      if (bal !== undefined) (bal as unknown as Quantities)[col] += n;
    };
    const unitOps: UnitOp[] = [];
    for (const m of moves) {
      const src = isColumn(m.from) ? need(m.source, 'source') : undefined;
      const dst = isColumn(m.to) ? need(m.target ?? m.source, 'target') : undefined;
      if (src !== undefined) {
        const col = COLUMN[m.from as keyof typeof COLUMN];
        const have = (balance.get(src.id) as unknown as Quantities)[col];
        if (have < m.qty)
          throw new ConflictError(`Only ${have} ${m.from.toLowerCase()} units in that position`, {
            details: { reason: 'INSUFFICIENT_STOCK', positionId: src.id, available: have },
          });
        bump(src, m.from, -m.qty);
      }
      if (dst !== undefined) bump(dst, m.to, m.qty);
      const main = src ?? dst;
      if (main === undefined) throw new Error('stock move must touch the warehouse');
      // Inventory deltas belong to the warehouse the units are in (source side when leaving).
      const d = inventoryDeltas(m.from, m.to, m.qty);
      if (src !== undefined && dst !== undefined && src.warehouseId !== dst.warehouseId)
        throw new Error('one move cannot cross warehouses (use IN_TRANSIT)');
      if (d.sellable !== 0 || d.damaged !== 0) {
        const byVar =
          inv.get(main.warehouseId) ?? new Map<string, { sellable: number; damaged: number }>();
        const cur = byVar.get(main.variantId) ?? { sellable: 0, damaged: 0 };
        cur.sellable += d.sellable;
        cur.damaged += d.damaged;
        byVar.set(main.variantId, cur);
        inv.set(main.warehouseId, byVar);
      }
      ledger.push({
        warehouseId: main.warehouseId,
        variantId: main.variantId,
        batchId: main.batchId,
        binId: (dst ?? main).binId,
        ownerType: (dst ?? main).ownerType,
        type: m.type,
        fromStatus: m.from,
        toStatus: m.to,
        qty: m.qty,
        sellableDelta: d.sellable,
        damagedDelta: d.damaged,
        refType: ctx.refType,
        refId: ctx.refId,
        refNo: ctx.refNo,
        reason: ctx.reason,
        actorUserId: ctx.actorUserId,
        requestId: ctx.requestId,
      });
      unitOps.push({ move: m, src, dst });
    }

    // 4. Write positions, summary, ledger.
    for (const [id, d] of posDelta) await this.repo.applyPosition(tx, id, d);
    for (const key of [...sumDelta.keys()].sort()) {
      const [warehouseId, variantId] = key.split('|') as [string, string];
      const sd = sumDelta.get(key);
      if (sd !== undefined)
        await this.repo.applySummary(tx, warehouseId, variantId, sd.d, sd.unknown);
    }
    await this.repo.insertMovements(tx, ledger);

    // 5. Unit QR of serialized batches (unit counts always equal the columns).
    await this.applyUnits(tx, unitOps, batchMap);

    // 6. Tell inventory (sellable / damaged totals), one event per warehouse.
    for (const [warehouseId, byVar] of inv) {
      const lines = [...byVar]
        .filter(([, d]) => d.sellable !== 0 || d.damaged !== 0)
        .map(([variantId, d]) => ({
          variantId,
          sellableDelta: d.sellable,
          damagedDelta: d.damaged,
        }));
      if (lines.length === 0) continue;
      await emitWarehouseEvent(
        tx,
        'warehouse.stock_changed.v1',
        {
          movementId: ctx.commandId,
          warehouseId,
          kind: ctx.kind,
          refNo: ctx.refNo,
          lines,
          actorUserId: ctx.actorUserId,
        },
        ctx.requestId ?? ctx.commandId,
      );
    }
    return { movements: ledger.length, deltas: inv, positionIds: [...pos.keys()] };
  }

  private async applyUnits(
    tx: Tx,
    ops: readonly UnitOp[],
    known: Map<string, { id: string; serialized: boolean; batchNo: string }>,
  ): Promise<void> {
    const ids = new Set(ops.map((o) => (o.src ?? o.dst)?.batchId).filter((x) => x !== undefined));
    const missing = [...ids].filter((id) => !known.has(id));
    const batches = new Map(known);
    for (const b of await this.repo.batches(missing, tx)) batches.set(b.id, b);
    const serializedOps = ops.filter(
      (o) => batches.get((o.src ?? o.dst)?.batchId ?? '')?.serialized,
    );
    if (serializedOps.length === 0) return;
    const skus = new Map(
      (
        await this.repo.variants(
          serializedOps.flatMap((o) => {
            const q = o.src ?? o.dst;
            return q === undefined ? [] : [q.variantId];
          }),
          tx,
        )
      ).map((v) => [v.variantId, v.sku]),
    );
    for (const { move: m, src, dst } of serializedOps) {
      const p = src ?? dst;
      const batch = p === undefined ? undefined : batches.get(p.batchId);
      if (p === undefined || batch === undefined) continue;
      if (src === undefined && dst !== undefined && !OUT_OF_WAREHOUSE.has(m.from)) {
        // Units enter the warehouse for the first time: new labels.
        const from = (await this.repo.maxUnitSeq(tx, batch.id)) + 1;
        const sku = skus.get(dst.variantId) ?? 'SKU';
        await this.repo.generateUnits(tx, {
          prefix: `FX-${clean(sku)}-${clean(batch.batchNo)}-`,
          from,
          qty: m.qty,
          batchId: batch.id,
          variantId: dst.variantId,
          warehouseId: dst.warehouseId,
          binId: dst.binId,
          ownerType: dst.ownerType,
          status: m.to,
        });
        continue;
      }
      const moved = await this.repo.moveUnits(tx, {
        batchId: batch.id,
        warehouseId: src === undefined ? null : src.warehouseId,
        binId: src === undefined ? null : src.binId,
        ownerType: p.ownerType,
        from: m.from,
        to: m.to,
        qty: m.qty,
        toWarehouseId:
          dst !== undefined ? dst.warehouseId : OUT_OF_WAREHOUSE.has(m.to) ? null : p.warehouseId,
        toBinId: dst !== undefined ? dst.binId : null,
        toOwnerType: (dst ?? p).ownerType,
        shipmentId: m.shipmentId ?? null,
      });
      if (moved !== m.qty)
        throw new Error(
          `unit QR out of step for batch ${batch.batchNo}: moved ${moved} of ${m.qty} (${m.from} → ${m.to})`,
        );
    }
  }
}

interface UnitOp {
  move: StockMove;
  src: PositionRow | undefined;
  dst: PositionRow | undefined;
}

type TransitionRow = Awaited<ReturnType<Cradle['stockRepository']['transitions']>>[number];

const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '');
