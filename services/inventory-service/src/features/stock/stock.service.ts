import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { one, requestHash } from '../../middleware/http.js';
import type { Actor } from '../audit/index.js';
import { byLockOrder, sellableOf } from './stock.rules.js';
import type {
  AdjustmentInput,
  DamageInput,
  DecisionInput,
  LedgerListQuery,
  LedgerRow,
  LevelListQuery,
  LevelRow,
  LevelView,
  NewLedgerRow,
  OperationLine,
  OperationListQuery,
  OperationView,
  ReceiptInput,
  StockMove,
  StockOperationType,
  ThresholdsInput,
  WriteOffInput,
} from './stock.types.js';

type Deps = Pick<
  Cradle,
  | 'stockRepository'
  | 'runInTransaction'
  | 'auditService'
  | 'warehousesService'
  | 'projectionsService'
  | 'settingsService'
>;

export interface OperationResult {
  operation: OperationView;
  /** true = an earlier request with the same Idempotency-Key; nothing moved this time. */
  replayed: boolean;
}

/** Thrown inside a transaction to roll it back when the Idempotency-Key was taken concurrently. */
class KeyTaken extends Error {}

const insufficient = (line: OperationLine, what: string) =>
  new ConflictError(`Not enough ${what} stock for variant ${line.variantId}`, {
    details: { reason: 'INSUFFICIENT_STOCK', variantId: line.variantId, requested: line.qty },
  });

const staffId = (actor: Actor): string => {
  if (actor.userId === null) throw new Error('stock operations need a staff actor');
  return actor.userId;
};

const byVariant = <T extends { variantId: string }>(lines: readonly T[]): T[] =>
  [...lines].sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));

/**
 * Manual stock movements (receipt, damage, write-off, approved adjustment). Each one is a single
 * transaction: operation row (Idempotency-Key + request hash) + one conditional UPDATE per line
 * (variant order) + ledger rows + audit row + availability dirty marks.
 */
export class StockService {
  constructor(private readonly deps: Deps) {}

  // ── Operations ──

  receive(actor: Actor, key: string, input: ReceiptInput): Promise<OperationResult> {
    return this.operation(actor, key, 'RECEIPT', input, async (tx, op) => {
      await this.deps.projectionsService.requireActive(
        input.lines.map((l) => l.variantId),
        (i) => `body.lines[${String(i)}].variantId`,
        tx,
      );
      const { defaultReorderLevel } = await this.deps.settingsService.current();
      const ledger: NewLedgerRow[] = [];
      for (const line of byVariant(input.lines)) {
        const after = await this.deps.stockRepository.addOnHand(
          tx,
          input.warehouseId,
          line.variantId,
          line.qty,
          defaultReorderLevel,
        );
        ledger.push(this.ledgerRow(actor, op, line.variantId, 'RECEIVE', line.qty, 0, after));
      }
      return { ledger, status: 'APPLIED', action: 'stock.receive' };
    });
  }

  damage(actor: Actor, key: string, input: DamageInput): Promise<OperationResult> {
    return this.operation(actor, key, 'DAMAGE', input, async (tx, op) => {
      const ledger: NewLedgerRow[] = [];
      for (const line of byVariant(input.lines)) {
        const after = await this.deps.stockRepository.moveToDamaged(
          tx,
          input.warehouseId,
          line.variantId,
          line.qty,
        );
        if (after === null) throw insufficient(line, 'unreserved');
        ledger.push(
          this.ledgerRow(actor, op, line.variantId, 'DAMAGE', -line.qty, line.qty, after),
        );
      }
      return { ledger, status: 'APPLIED', action: 'stock.damage' };
    });
  }

  writeOff(actor: Actor, key: string, input: WriteOffInput): Promise<OperationResult> {
    return this.operation(actor, key, 'WRITE_OFF', input, async (tx, op) => {
      const ledger: NewLedgerRow[] = [];
      for (const line of byVariant(input.lines)) {
        const after = await this.deps.stockRepository.writeOffDamaged(
          tx,
          input.warehouseId,
          line.variantId,
          line.qty,
        );
        if (after === null) throw insufficient(line, 'damaged');
        ledger.push(this.ledgerRow(actor, op, line.variantId, 'WRITE_OFF', 0, -line.qty, after));
      }
      return { ledger, status: 'APPLIED', action: 'stock.write_off' };
    });
  }

  /** Raises a PENDING adjustment; nothing moves until another person approves it. */
  requestAdjustment(actor: Actor, key: string, input: AdjustmentInput): Promise<OperationResult> {
    return this.operation(actor, key, 'ADJUSTMENT', input, async (tx) => {
      const known = await this.deps.projectionsService.byIds(
        input.lines.map((l) => l.variantId),
        tx,
      );
      const issues = input.lines.flatMap((l, i) =>
        known.has(l.variantId)
          ? []
          : [{ path: `body.lines[${String(i)}].variantId`, message: 'unknown variant' }],
      );
      if (issues.length > 0) throw new ValidationError(issues);
      return { ledger: [], status: 'PENDING', action: 'adjustment.request' };
    });
  }

  /** Applies a PENDING adjustment. Segregation of duties: approver ≠ requester. */
  async approveAdjustment(actor: Actor, id: string, input: DecisionInput): Promise<OperationView> {
    const userId = staffId(actor);
    return this.deps.runInTransaction(async (tx) => {
      const op = await this.pendingAdjustment(tx, id);
      if (op.requestedBy === userId)
        throw new ForbiddenError('An adjustment must be approved by someone other than its requester');
      await this.deps.warehousesService.requireActive(tx, op.warehouseId);
      const { defaultReorderLevel } = await this.deps.settingsService.current();
      const ledger: NewLedgerRow[] = [];
      for (const line of byVariant(op.lines)) {
        if (line.qty > 0) {
          const after = await this.deps.stockRepository.addOnHand(
            tx,
            op.warehouseId,
            line.variantId,
            line.qty,
            defaultReorderLevel,
          );
          ledger.push(this.ledgerRow(actor, op, line.variantId, 'ADJUST_IN', line.qty, 0, after));
        } else {
          const after = await this.deps.stockRepository.removeOnHand(
            tx,
            op.warehouseId,
            line.variantId,
            -line.qty,
          );
          if (after === null) throw insufficient({ ...line, qty: -line.qty }, 'unreserved');
          ledger.push(this.ledgerRow(actor, op, line.variantId, 'ADJUST_OUT', line.qty, 0, after));
        }
      }
      const decided = await this.deps.stockRepository.decideOperation(
        tx,
        id,
        'APPLIED',
        userId,
        input.reason,
      );
      await this.deps.stockRepository.insertLedger(tx, ledger);
      await this.deps.stockRepository.markDirty(tx, op.lines.map((l) => l.variantId));
      await this.deps.auditService.record(tx, actor, {
        action: 'adjustment.approve',
        targetType: 'operation',
        targetId: id,
        after: { status: 'APPLIED', lines: op.lines },
        reason: input.reason,
      });
      return decided;
    });
  }

  async rejectAdjustment(actor: Actor, id: string, input: DecisionInput): Promise<OperationView> {
    const userId = staffId(actor);
    return this.deps.runInTransaction(async (tx) => {
      await this.pendingAdjustment(tx, id);
      const decided = await this.deps.stockRepository.decideOperation(
        tx,
        id,
        'REJECTED',
        userId,
        input.reason,
      );
      await this.deps.auditService.record(tx, actor, {
        action: 'adjustment.reject',
        targetType: 'operation',
        targetId: id,
        after: { status: 'REJECTED' },
        reason: input.reason,
      });
      return decided;
    });
  }

  async setThresholds(
    actor: Actor,
    warehouseId: string,
    variantId: string,
    input: ThresholdsInput,
  ): Promise<LevelView> {
    const { reason, ...thresholds } = input;
    const after = await this.deps.runInTransaction(async (tx) => {
      await this.deps.warehousesService.requireExists(tx, warehouseId);
      const known = await this.deps.projectionsService.byIds([variantId], tx);
      if (!known.has(variantId)) throw new NotFoundError('Variant');
      const { defaultReorderLevel } = await this.deps.settingsService.current();
      const res = await this.deps.stockRepository.setThresholds(
        tx,
        warehouseId,
        variantId,
        thresholds,
        defaultReorderLevel,
      );
      await this.deps.stockRepository.markDirty(tx, [variantId]);
      await this.deps.auditService.record(tx, actor, {
        action: 'stock.thresholds',
        targetType: 'stock_level',
        targetId: res.after.id,
        before:
          res.before === null
            ? null
            : { reorderLevel: res.before.reorderLevel, safetyStock: res.before.safetyStock },
        after: { reorderLevel: res.after.reorderLevel, safetyStock: res.after.safetyStock },
        reason,
      });
      return res.after;
    });
    return one(await this.views([after]), 'stock level');
  }

  // ── Reads ──

  async listLevels(query: LevelListQuery): Promise<Paginated<LevelView>> {
    const page = await this.deps.stockRepository.listLevels(query);
    return { ...page, items: await this.views(page.items) };
  }

  async getLevel(warehouseId: string, variantId: string): Promise<LevelView> {
    const row = await this.deps.stockRepository.findLevel(warehouseId, variantId);
    if (row === null) throw new NotFoundError('Stock level');
    return one(await this.views([row]), 'stock level');
  }

  listOperations(query: OperationListQuery): Promise<Paginated<OperationView>> {
    return this.deps.stockRepository.listOperations(query);
  }

  async getOperation(id: string): Promise<OperationView> {
    const op = await this.deps.stockRepository.findOperation(id);
    if (op === null) throw new NotFoundError('Stock operation');
    return op;
  }

  listLedger(query: LedgerListQuery): Promise<Paginated<LedgerRow>> {
    return this.deps.stockRepository.listLedger(query);
  }

  // ── Primitives for the reservations feature (always inside its transaction) ──

  /** Sellable units of these variants in these warehouses, keyed `warehouseId|variantId`. */
  async sellableMap(
    warehouseIds: readonly string[],
    variantIds: readonly string[],
  ): Promise<Map<string, number>> {
    const rows = await this.deps.stockRepository.sellable(warehouseIds, variantIds);
    return new Map(rows.map((r) => [`${r.warehouseId}|${r.variantId}`, r.sellable]));
  }

  /**
   * Holds every move or none: false as soon as one line is short (the caller's transaction must
   * then roll back). Moves are applied in (warehouseId, variantId) order.
   */
  async holdAllInTx(tx: Tx, moves: readonly StockMove[]): Promise<boolean> {
    for (const m of sortMoves(moves)) {
      if (!(await this.deps.stockRepository.hold(tx, m.warehouseId, m.variantId, m.qty)))
        return false;
    }
    await this.deps.stockRepository.markDirty(tx, moves.map((m) => m.variantId));
    return true;
  }

  /** Gives held units back. A shortfall here means corrupted counters → throw (roll back). */
  async releaseAllInTx(tx: Tx, moves: readonly StockMove[]): Promise<void> {
    for (const m of sortMoves(moves)) {
      if (m.qty <= 0) continue;
      if (!(await this.deps.stockRepository.unhold(tx, m.warehouseId, m.variantId, m.qty)))
        throw new Error(
          `reserved < ${String(m.qty)} for ${m.warehouseId}/${m.variantId}: counters out of sync`,
        );
    }
    await this.deps.stockRepository.markDirty(tx, moves.map((m) => m.variantId));
  }

  markWarehouseDirty(warehouseId: string): Promise<void> {
    return this.deps.stockRepository.markWarehouseDirty(warehouseId);
  }

  // ── Helpers ──

  private async operation(
    actor: Actor,
    key: string,
    type: StockOperationType,
    input: ReceiptInput | DamageInput,
    apply: (
      tx: Tx,
      op: OperationView,
    ) => Promise<{ ledger: NewLedgerRow[]; status: 'APPLIED' | 'PENDING'; action: string }>,
  ): Promise<OperationResult> {
    const userId = staffId(actor);
    const hash = requestHash({ type, ...input });
    const replay = async (): Promise<OperationResult | null> => {
      const existing = await this.deps.stockRepository.findOperationByKey(key);
      if (existing === null) return null;
      if (existing.requestHash !== hash || existing.view.type !== type)
        throw new ValidationError(
          [{ path: 'headers.idempotency-key', message: 'already used for a different request' }],
          'Idempotency-Key reused with a different request',
        );
      return { operation: existing.view, replayed: true };
    };

    const earlier = await replay();
    if (earlier !== null) return earlier;
    try {
      const operation = await this.deps.runInTransaction(async (tx) => {
        await this.deps.warehousesService.requireActive(tx, input.warehouseId);
        const status = type === 'ADJUSTMENT' ? 'PENDING' : 'APPLIED';
        const op = await this.deps.stockRepository.createOperation(tx, {
          type,
          status,
          warehouseId: input.warehouseId,
          lines: input.lines,
          reference: 'reference' in input ? (input.reference ?? null) : null,
          reason: input.reason ?? null,
          idempotencyKey: key,
          requestHash: hash,
          requestedBy: userId,
        });
        if (op === null) throw new KeyTaken();
        const result = await apply(tx, op);
        await this.deps.stockRepository.insertLedger(tx, result.ledger);
        if (result.ledger.length > 0)
          await this.deps.stockRepository.markDirty(tx, input.lines.map((l) => l.variantId));
        await this.deps.auditService.record(tx, actor, {
          action: result.action,
          targetType: 'operation',
          targetId: op.id,
          after: { type, warehouseId: input.warehouseId, lines: input.lines },
          reason: input.reason ?? null,
        });
        return op;
      });
      return { operation, replayed: false };
    } catch (error) {
      if (!(error instanceof KeyTaken)) throw error;
      const raced = await replay();
      if (raced === null) throw new ConflictError('Concurrent request with this Idempotency-Key');
      return raced;
    }
  }

  private async pendingAdjustment(tx: Tx, id: string): Promise<OperationView> {
    const op = await this.deps.stockRepository.lockOperation(tx, id);
    if (op?.type !== 'ADJUSTMENT') throw new NotFoundError('Adjustment');
    if (op.status !== 'PENDING')
      throw new ConflictError(`Adjustment is already ${op.status}`, {
        details: { reason: 'NOT_PENDING', status: op.status },
      });
    return op;
  }

  private ledgerRow(
    actor: Actor,
    op: OperationView,
    variantId: string,
    type: NewLedgerRow['type'],
    onHandDelta: number,
    damagedDelta: number,
    after: { onHand: number; damaged: number },
  ): NewLedgerRow {
    return {
      warehouseId: op.warehouseId,
      variantId,
      type,
      onHandDelta,
      damagedDelta,
      onHandAfter: after.onHand,
      damagedAfter: after.damaged,
      refType: 'operation',
      refId: op.id,
      actorUserId: actor.userId,
      requestId: actor.requestId,
    };
  }

  private async views(rows: readonly LevelRow[]): Promise<LevelView[]> {
    const facts = await this.deps.projectionsService.byIds(rows.map((r) => r.variantId));
    return rows.map((r) => {
      const sellable = sellableOf(r);
      return {
        ...r,
        sku: facts.get(r.variantId)?.sku ?? null,
        name: facts.get(r.variantId)?.name ?? null,
        sellable,
        lowStock: r.reorderLevel > 0 && sellable <= r.reorderLevel,
      };
    });
  }
}

const sortMoves = (moves: readonly StockMove[]): StockMove[] => [...moves].sort(byLockOrder);
