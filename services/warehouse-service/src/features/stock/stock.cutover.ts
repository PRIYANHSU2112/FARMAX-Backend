import { AppError, ConflictError, ErrorCode } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';
import type { InventoryLedgerRow, InventoryLevel } from '../../adapters/inventory-client.js';
import { emitWarehouseEvent } from '../../adapters/events.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { Caller } from '../../middleware/guards.js';
import type { ApplyContext, StockMove } from './stock.engine.js';
import type { PositionRow } from './stock.repository.js';
import { type CutoverState, fefoCompare } from './stock.rules.js';

const OPENING_REVIEW = ['ownerType', 'bin', 'batch'];
const SYSTEM = { userId: null, ip: null, requestId: null };

/**
 * Inventory → warehouse cutover (D-57a §2a.1): freeze (≤ freezeMaxMinutes, auto-unfreeze) →
 * reject in-flight inventory operations → snapshot → opening balances (or replay after a
 * rollback; tables are never truncated) → verify totals → activate. Rollback only within
 * `stock.rollbackWindowHours` (72 h) of activation; later only fix-forward.
 */
export class StockCutover {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'stockRepository'
      | 'stockEngine'
      | 'stockSettings'
      | 'stockService'
      | 'inventoryClient'
      | 'runInTransaction'
      | 'auditService'
      | 'logger'
    >,
  ) {}

  async status() {
    const s = await this.deps.stockSettings.all();
    const inv = await this.deps.inventoryClient.cutoverState().catch(() => null);
    return {
      wmsMode: await this.deps.stockSettings.writesMode(),
      inventoryMode: inv?.mode ?? null,
      pendingInventoryOperations: inv?.pendingOperations ?? null,
      state: s['stock.cutover'],
      freezeMaxMinutes: s['stock.freezeMaxMinutes'],
      rollbackWindowHours: s['stock.rollbackWindowHours'],
    };
  }

  /** INVENTORY → FROZEN on both sides; deadline = now + freezeMaxMinutes. */
  async freeze(caller: Caller, reason: string) {
    const s = await this.deps.stockSettings.all();
    const mode = await this.deps.stockSettings.writesMode();
    if (mode === 'WMS') throw this.state('The cutover is already active');
    await this.deps.inventoryClient.cutoverStep('freeze', caller.userId);
    const now = new Date();
    const deadline = new Date(now.getTime() + s['stock.freezeMaxMinutes'] * 60_000);
    const prev = s['stock.cutover'];
    await this.save(caller.userId, 'FROZEN', {
      phase: 'FROZEN',
      frozenAt: now.toISOString(),
      freezeDeadline: deadline.toISOString(),
      reason,
      // A re-cutover after a rollback replays the inventory changes made meanwhile.
      ...(prev?.rolledBackAt === undefined ? {} : { rolledBackAt: prev.rolledBackAt }),
    });
    return this.status();
  }

  /** FROZEN → INVENTORY on both sides (manual abort or the deadline job). */
  async abort(by: string | null, why: string) {
    if ((await this.deps.stockSettings.writesMode()) !== 'FROZEN')
      throw this.state('Nothing to abort: stock writes are not frozen');
    await this.deps.inventoryClient.cutoverStep('unfreeze', by);
    const prev = await this.deps.stockSettings.get('stock.cutover');
    await this.save(by, 'INVENTORY', {
      ...(prev ?? { phase: 'FROZEN' }),
      phase: 'ROLLED_BACK',
      reason: why,
      rolledBackAt: prev?.rolledBackAt,
    });
    return this.status();
  }

  /** Steps 3–6: reject pending, snapshot, import or replay, verify, activate. */
  async run(caller: Caller) {
    const state = await this.deps.stockSettings.get('stock.cutover');
    if ((await this.deps.stockSettings.writesMode()) !== 'FROZEN' || state === null)
      throw this.state('Freeze stock writes first');
    if (state.freezeDeadline !== undefined && Date.now() > Date.parse(state.freezeDeadline))
      throw this.state('The freeze window has passed; freeze again');
    const rejected = await this.deps.inventoryClient.rejectPending('CUTOVER_MOVED_TO_WMS');
    const levels = await this.snapshot();
    const reimport = state.rolledBackAt !== undefined;
    const replayed = reimport ? await this.replay(new Date(state.rolledBackAt ?? 0)) : 0;
    const imported = reimport ? 0 : await this.importOpening(levels);
    const mismatches = await this.verify(levels);
    const report = {
      rejectedOperations: rejected,
      levels: levels.length,
      imported,
      replayed,
      mismatches: mismatches.slice(0, 50),
      mismatchCount: mismatches.length,
    };
    if (mismatches.length > 0) {
      await this.save(caller.userId, 'FROZEN', { ...state, report });
      throw new ConflictError('Totals do not match inventory; still frozen', {
        details: { reason: 'CUTOVER_MISMATCH', ...report },
      });
    }
    await this.deps.inventoryClient.cutoverStep('activate', caller.userId);
    await this.save(caller.userId, 'WMS', {
      phase: 'ACTIVE',
      frozenAt: state.frozenAt,
      activatedAt: new Date().toISOString(),
      report,
    });
    return { ...(await this.status()), report };
  }

  /** WMS → INVENTORY, only within the rollback window. WMS tables become read-only, never wiped. */
  async rollback(caller: Caller, reason: string) {
    const s = await this.deps.stockSettings.all();
    const state = s['stock.cutover'];
    if ((await this.deps.stockSettings.writesMode()) !== 'WMS' || state?.activatedAt === undefined)
      throw this.state('The cutover is not active');
    const age = Date.now() - Date.parse(state.activatedAt);
    if (age > s['stock.rollbackWindowHours'] * 3_600_000)
      throw new AppError(ErrorCode.CONFLICT, 'The rollback window has closed; fix forward', 409, {
        details: { reason: 'ROLLBACK_WINDOW_CLOSED' },
      });
    await this.deps.inventoryClient.cutoverStep('rollback', caller.userId);
    await this.save(caller.userId, 'INVENTORY', {
      ...state,
      phase: 'ROLLED_BACK',
      rolledBackAt: new Date().toISOString(),
      reason,
    });
    return this.status();
  }

  /** Job: a freeze past its deadline is undone automatically. */
  async watch(): Promise<void> {
    const state = await this.deps.stockSettings.get('stock.cutover');
    if (state?.phase !== 'FROZEN' || state.freezeDeadline === undefined) return;
    if ((await this.deps.stockSettings.writesMode()) !== 'FROZEN') return;
    if (Date.now() <= Date.parse(state.freezeDeadline)) return;
    this.deps.logger.warn({ state }, 'stock cutover freeze deadline passed: auto-unfreeze');
    await this.abort(null, 'FREEZE_DEADLINE_PASSED');
  }

  // ── steps ──

  private async snapshot(): Promise<InventoryLevel[]> {
    const out: InventoryLevel[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.deps.inventoryClient.snapshot(cursor);
      out.push(...page);
      if (page.length < 2000) return out;
      cursor = page.at(-1)?.id;
    }
  }

  /** One OPENING lot per warehouse × SKU (bin / batch / owner to confirm). Idempotent. */
  private async importOpening(levels: readonly InventoryLevel[]): Promise<number> {
    await this.deps.stockService.ensureVariants([...new Set(levels.map((l) => l.variantId))]);
    let imported = 0;
    for (let i = 0; i < levels.length; i += 200) {
      const chunk = levels.slice(i, i + 200);
      imported += await this.deps.runInTransaction(async (tx) => {
        let n = 0;
        for (const l of chunk) {
          const t = { safetyStock: l.safetyStock, reorderLevel: l.reorderLevel, targetStock: 0 };
          await this.deps.stockRepository.seedThreshold(tx, l.warehouseId, l.variantId, t);
          if (await this.deps.stockRepository.hasSummary(tx, l.warehouseId, l.variantId)) continue;
          if (l.onHand <= 0 && l.damaged <= 0) continue;
          const batch = await this.openingBatch(tx, l.variantId, 'OPENING');
          const target = {
            warehouseId: l.warehouseId,
            variantId: l.variantId,
            batchId: batch,
            binId: null,
            ownerType: 'FARMX' as const,
            vendorId: null,
            reviewFields: OPENING_REVIEW,
          };
          const moves: StockMove[] = [];
          if (l.onHand > 0)
            moves.push({
              type: 'OPENING',
              from: 'RECEIVED',
              to: 'AVAILABLE',
              qty: l.onHand,
              target,
            });
          if (l.damaged > 0)
            moves.push({
              type: 'OPENING',
              from: 'RECEIVED',
              to: 'DAMAGED',
              qty: l.damaged,
              target,
            });
          await this.deps.stockEngine.apply(tx, moves, this.ctx('OPENING'));
          n += 1;
        }
        return n;
      });
    }
    return imported;
  }

  /** Re-cutover: inventory ledger rows written while inventory owned stock again. */
  private async replay(since: Date): Promise<number> {
    let cursor: string | undefined;
    let n = 0;
    for (;;) {
      const rows = await this.deps.inventoryClient.ledgerSince(since, cursor);
      for (const r of rows) {
        await this.deps.runInTransaction(async (tx) => {
          await this.deps.stockEngine.apply(
            tx,
            await this.replayMoves(tx, r),
            this.ctx('ROLLBACK_REPLAY'),
          );
        });
        n += 1;
      }
      if (rows.length < 2000) return n;
      cursor = rows.at(-1)?.id;
    }
  }

  private async replayMoves(
    tx: Parameters<Parameters<Cradle['runInTransaction']>[0]>[0],
    r: InventoryLedgerRow,
  ): Promise<StockMove[]> {
    const moves: StockMove[] = [];
    if (r.onHandDelta > 0) {
      const batch = await this.openingBatch(
        tx,
        r.variantId,
        `REPLAY-${r.createdAt.slice(2, 10).replaceAll('-', '')}`,
      );
      moves.push({
        type: 'ROLLBACK_REPLAY',
        from: 'RECEIVED',
        to: 'AVAILABLE',
        qty: r.onHandDelta,
        target: {
          warehouseId: r.warehouseId,
          variantId: r.variantId,
          batchId: batch,
          binId: null,
          ownerType: 'FARMX',
          vendorId: null,
          reviewFields: OPENING_REVIEW,
        },
      });
    }
    if (r.onHandDelta < 0) {
      // FEFO-first, bin = null positions last.
      const positions = (
        await this.deps.stockRepository.lockVariantPositions(tx, r.warehouseId, r.variantId)
      )
        .filter((p) => p.available > 0)
        .sort(
          (a, b) => (a.binId === null ? 1 : 0) - (b.binId === null ? 1 : 0) || fefoCompare(a, b),
        );
      const to = r.damagedDelta > 0 ? 'DAMAGED' : 'WRITTEN_OFF';
      let left = -r.onHandDelta;
      for (const p of positions) {
        const q = Math.min(left, p.available);
        if (q <= 0) continue;
        moves.push({
          type: 'ROLLBACK_REPLAY',
          from: 'AVAILABLE',
          to,
          qty: q,
          source: { id: p.id },
        });
        left -= q;
        if (left === 0) break;
      }
      if (left > 0)
        throw new ConflictError(`Replay needs ${left} more units of ${r.variantId}`, {
          details: { reason: 'CUTOVER_MISMATCH' },
        });
    } else if (r.damagedDelta < 0) {
      const positions = (
        await this.deps.stockRepository.lockVariantPositions(tx, r.warehouseId, r.variantId)
      ).filter((p: PositionRow) => p.damaged > 0);
      let left = -r.damagedDelta;
      for (const p of positions) {
        const q = Math.min(left, p.damaged);
        if (q <= 0) continue;
        moves.push({
          type: 'ROLLBACK_REPLAY',
          from: 'DAMAGED',
          to: 'WRITTEN_OFF',
          qty: q,
          source: { id: p.id },
        });
        left -= q;
        if (left === 0) break;
      }
    }
    return moves;
  }

  /** WMS sellable / damaged per warehouse × SKU must equal inventory onHand / damaged. */
  private async verify(levels: readonly InventoryLevel[]) {
    const wms = new Map(
      (await this.deps.stockRepository.summaryTotals()).map((r) => [
        `${r.warehouseId}|${r.variantId}`,
        r,
      ]),
    );
    const out: {
      warehouseId: string;
      variantId: string;
      inventory: { onHand: number; damaged: number };
      wms: { sellable: number; damaged: number };
    }[] = [];
    const seen = new Set<string>();
    for (const l of levels) {
      const key = `${l.warehouseId}|${l.variantId}`;
      seen.add(key);
      const w = wms.get(key) ?? { sellable: 0, damaged: 0 };
      if (w.sellable !== l.onHand || w.damaged !== l.damaged)
        out.push({
          warehouseId: l.warehouseId,
          variantId: l.variantId,
          inventory: { onHand: l.onHand, damaged: l.damaged },
          wms: { sellable: w.sellable, damaged: w.damaged },
        });
    }
    for (const [key, w] of wms)
      if (!seen.has(key) && (w.sellable !== 0 || w.damaged !== 0)) {
        const [warehouseId, variantId] = key.split('|') as [string, string];
        out.push({
          warehouseId,
          variantId,
          inventory: { onHand: 0, damaged: 0 },
          wms: { sellable: w.sellable, damaged: w.damaged },
        });
      }
    return out;
  }

  // ── helpers ──

  private async openingBatch(
    tx: Parameters<Parameters<Cradle['runInTransaction']>[0]>[0],
    variantId: string,
    batchNo: string,
  ): Promise<string> {
    const found = await this.deps.stockRepository.batchByNo(variantId, batchNo, tx);
    if (found !== null) return found.id;
    const b = await this.deps.stockRepository.createBatch(tx, {
      variantId,
      batchNo,
      isOpening: true,
    });
    return b.id;
  }

  private ctx(kind: string): ApplyContext {
    return {
      commandId: uuidv7(),
      kind,
      refType: 'CUTOVER',
      refId: null,
      refNo: null,
      reason: kind,
      actorUserId: null,
      requestId: null,
      enforce: 'none',
      silent: true,
      modes: ['FROZEN'],
    };
  }

  private async save(by: string | null, mode: 'INVENTORY' | 'FROZEN' | 'WMS', state: CutoverState) {
    await this.deps.runInTransaction(async (tx) => {
      await this.deps.stockSettings.set(tx, 'stock.writesMode', mode, by);
      await this.deps.stockSettings.set(tx, 'stock.cutover', state, by);
      await emitWarehouseEvent(
        tx,
        'warehouse.stock_cutover.v1',
        {
          phase: state.phase,
          mode,
          frozenAt: state.frozenAt ?? null,
          freezeDeadline: state.freezeDeadline ?? null,
          activatedAt: state.activatedAt ?? null,
          rolledBackAt: state.rolledBackAt ?? null,
          reason: state.reason ?? null,
        },
        uuidv7(),
      );
      await this.deps.auditService.record(
        tx,
        { ...SYSTEM, userId: by },
        {
          action: `stock.cutover_${state.phase.toLowerCase()}`,
          targetType: 'stock_cutover',
          targetId: '00000000-0000-0000-0000-000000000000',
          after: { mode, ...state },
          reason: state.reason ?? null,
        },
      );
    });
  }

  private state(message: string) {
    return new ConflictError(message, { details: { reason: 'CUTOVER_STATE' } });
  }
}
