import { ConflictError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { WarehouseStockChangedV1, WarehouseThresholdsChangedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';
import type { StockWritesMode } from '../settings/index.js';
import type { NewLedgerRow } from './stock.types.js';

const SYSTEM_ACTOR = { userId: null, ip: null, requestId: null };

/** Ledger type of one WMS line (what inventory's ledger shows). */
export const ledgerTypeOf = (
  kind: string,
  sellable: number,
  damaged: number,
): NewLedgerRow['type'] => {
  if (damaged !== 0 && sellable === 0) return damaged > 0 ? 'DAMAGE' : 'WRITE_OFF';
  if (kind === 'DAMAGE') return 'DAMAGE';
  if (sellable > 0) {
    if (kind === 'RECEIPT') return 'RECEIVE';
    if (kind === 'QC_RELEASE') return 'QUALITY_RELEASE';
    if (kind === 'TRANSFER_IN') return 'TRANSFER_IN';
    if (kind === 'RESTOCK' || kind === 'RETURN') return 'RETURN';
    return 'ADJUST_IN';
  }
  if (kind === 'QC_HOLD' || kind === 'QUARANTINE' || kind === 'EXPIRE') return 'QUALITY_HOLD';
  if (kind === 'TRANSFER_OUT') return 'TRANSFER_OUT';
  if (kind === 'WRITE_OFF') return 'WRITE_OFF';
  if (kind === 'ISSUE') return 'SALE';
  return 'ADJUST_OUT';
};

/**
 * D-57a: inventory fed by warehouse-service (single writer) and the cutover handshake.
 * - `warehouse.stock_changed.v1` → onHand / damaged deltas + ledger (`refType` wms_movement).
 * - `warehouse.thresholds_changed.v1` → read-only thresholds copy (version-guarded).
 * - Cutover: INVENTORY → FROZEN (pending operations listed, then rejected) → WMS; rollback → INVENTORY.
 */
export class WmsSyncService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      'stockRepository' | 'settingsService' | 'runInTransaction' | 'auditService'
    >,
  ) {}

  async applyStockChanged(tx: Tx, d: WarehouseStockChangedV1): Promise<void> {
    const repo = this.deps.stockRepository;
    const { defaultReorderLevel } = await this.deps.settingsService.current();
    const ledger: NewLedgerRow[] = [];
    for (const l of d.lines) {
      if (l.sellableDelta === 0 && l.damagedDelta === 0) continue;
      const after = await repo.applyWmsDelta(
        tx,
        d.warehouseId,
        l.variantId,
        l.sellableDelta,
        l.damagedDelta,
        defaultReorderLevel,
      );
      ledger.push({
        warehouseId: d.warehouseId,
        variantId: l.variantId,
        type: ledgerTypeOf(d.kind, l.sellableDelta, l.damagedDelta),
        onHandDelta: l.sellableDelta,
        damagedDelta: l.damagedDelta,
        onHandAfter: after.onHand,
        damagedAfter: after.damaged,
        refType: 'wms_movement',
        refId: d.movementId,
        actorUserId: d.actorUserId,
        requestId: null,
      });
    }
    await repo.insertLedger(tx, ledger);
    await repo.markDirty(
      tx,
      ledger.map((r) => r.variantId),
    );
  }

  async applyThresholds(tx: Tx, t: WarehouseThresholdsChangedV1): Promise<void> {
    const changed = await this.deps.stockRepository.applyWmsThresholds(tx, t);
    if (changed) await this.deps.stockRepository.markDirty(tx, [t.variantId]);
  }

  // ── Cutover (internal API, called by warehouse-service) ──

  async state() {
    return {
      mode: await this.deps.settingsService.writesMode(),
      pendingOperations: await this.deps.stockRepository.pendingOperations(),
    };
  }

  /** INVENTORY → FROZEN (idempotent when already FROZEN). */
  freeze(by: string | null) {
    return this.move(['INVENTORY', 'FROZEN'], 'FROZEN', by, 'stock.cutover_frozen');
  }

  /** FROZEN → INVENTORY (freeze deadline passed / aborted). */
  unfreeze(by: string | null) {
    return this.move(['FROZEN', 'INVENTORY'], 'INVENTORY', by, 'stock.cutover_unfrozen');
  }

  /** FROZEN → WMS. */
  activate(by: string | null) {
    return this.move(['FROZEN', 'WMS'], 'WMS', by, 'stock.cutover_activated');
  }

  /** WMS → INVENTORY (warehouse-service enforces the rollback window). */
  rollback(by: string | null) {
    return this.move(['WMS', 'INVENTORY'], 'INVENTORY', by, 'stock.cutover_rolled_back');
  }

  /** Rejects every PENDING operation (cutover step 3); returns their ids for the report. */
  async rejectPending(reason: string): Promise<string[]> {
    return this.deps.runInTransaction(async (tx) => {
      if ((await this.deps.settingsService.writesMode(tx)) !== 'FROZEN')
        throw new ConflictError('Freeze stock writes first', { details: { reason: 'NOT_FROZEN' } });
      const ids = await this.deps.stockRepository.rejectPending(tx, reason);
      await this.deps.auditService.record(tx, SYSTEM_ACTOR, {
        action: 'stock.cutover_rejected_pending',
        targetType: 'operation',
        targetId: ids[0] ?? '00000000-0000-0000-0000-000000000000',
        after: { ids },
        reason,
      });
      return ids;
    });
  }

  snapshot(cursor: string | undefined, limit: number) {
    return this.deps.stockRepository.levelsPage(cursor, limit);
  }

  ledgerSince(since: Date, cursor: string | undefined, limit: number) {
    return this.deps.stockRepository.ledgerSince(since, cursor, limit);
  }

  private async move(
    allowed: readonly StockWritesMode[],
    to: StockWritesMode,
    by: string | null,
    action: string,
  ): Promise<{ mode: StockWritesMode }> {
    return this.deps.runInTransaction(async (tx) => {
      const mode = await this.deps.settingsService.writesMode(tx);
      if (!allowed.includes(mode))
        throw new ConflictError(`Stock writes mode is ${mode}`, {
          details: { reason: 'CUTOVER_STATE', mode },
        });
      if (mode !== to) {
        await this.deps.settingsService.setWritesMode(tx, to, by);
        await this.deps.auditService.record(
          tx,
          { ...SYSTEM_ACTOR, userId: by },
          {
            action,
            targetType: 'operation',
            targetId: '00000000-0000-0000-0000-000000000000',
            before: { mode },
            after: { mode: to },
          },
        );
      }
      return { mode: to };
    });
  }
}
