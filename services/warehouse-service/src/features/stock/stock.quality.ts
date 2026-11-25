import type { Tx } from '@farmx/database';
import type {
  QualityBatchStateChangedV1,
  QualityDecisionRequestedV1,
  QualityDecisionRetryRequestedV1,
  QualitySpecChangedV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { type EventHandlerMap, emitWarehouseEvent } from '../../adapters/events.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { StockMove } from './stock.engine.js';
import type { QualityTaskRow, QualityTaskStatus } from './stock.quality.repository.js';

/** Retry delays after the 1st … 5th failure; the 6th failure is final (FAILED). */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 60 * 60_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
/** Tasks per job tick. */
const BATCH = 50;

/**
 * D-60: warehouse side of quality decisions (quality-service decides, this service moves stock).
 *  - `quality.decision_requested.v1` → one task per warehouse holding the batch (same inbox tx).
 *  - Job: each task runs in ITS OWN transaction (row-locked positions, the stock engine, audit,
 *    `warehouse.quality_task_updated.v1`), so one warehouse failing never undoes another.
 *    Key = decisionId × warehouseId and the task status is checked under lock → never moved twice.
 *  - A task of an older decision than the batch's latest (`qualityVersion`) is SUPERSEDED.
 */
export class StockQuality {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'stockQualityRepository'
      | 'stockRepository'
      | 'stockEngine'
      | 'runInTransaction'
      | 'auditService'
      | 'logger'
      | 'fulfilmentQueries'
      | 'warehousesService'
    >,
  ) {}

  private get repo() {
    return this.deps.stockQualityRepository;
  }

  /** Event handlers (merged into the stock feature's handler map). */
  handlers(): EventHandlerMap {
    return {
      'quality.spec_changed.v1': async (e, tx) => {
        const d = e.data as QualitySpecChangedV1;
        await this.repo.upsertPolicy(tx, d);
      },
      'quality.batch_state_changed.v1': async (e, tx) => {
        const d = e.data as QualityBatchStateChangedV1;
        await this.repo.setCertificate(tx, d.batchId, d.certificateStatus, d.coaRef);
      },
      'quality.decision_requested.v1': (e, tx) =>
        this.plan(tx, e.data as QualityDecisionRequestedV1, e.correlationId),
      'quality.decision_retry_requested.v1': async (e, tx) => {
        const d = e.data as QualityDecisionRetryRequestedV1;
        await this.repo.resetFailed(tx, d.decisionId, d.warehouseIds);
      },
    };
  }

  /** One task per warehouse holding the batch (inside the inbox transaction). */
  async plan(tx: Tx, d: QualityDecisionRequestedV1, correlationId: string): Promise<void> {
    const newest = await this.repo.bumpQuality(tx, d.batchId, d.stateVersion, d.kind !== 'RELEASE');
    const holders = await this.repo.holders(tx, d.batchId, d.kind);
    const status: QualityTaskStatus = newest ? 'PENDING' : 'SUPERSEDED';
    await this.repo.insertTasks(
      tx,
      holders.map((warehouseId) => ({
        decisionId: d.decisionId,
        warehouseId,
        batchId: d.batchId,
        decisionNo: d.decisionNo,
        kind: d.kind,
        stateVersion: d.stateVersion,
        actorUserId: d.actorUserId,
        reason: d.reason.slice(0, 500),
        status,
      })),
    );
    await emitWarehouseEvent(
      tx,
      'warehouse.quality_tasks_planned.v1',
      { decisionId: d.decisionId, batchId: d.batchId, warehouseIds: holders },
      correlationId,
    );
    if (!newest)
      for (const warehouseId of holders)
        await emitWarehouseEvent(
          tx,
          'warehouse.quality_task_updated.v1',
          {
            decisionId: d.decisionId,
            batchId: d.batchId,
            warehouseId,
            status,
            qtyMoved: 0,
            attempts: 0,
            error: null,
          },
          correlationId,
        );
  }

  /** Job tick: run due tasks one by one (each its own transaction). */
  async runDue(): Promise<number> {
    const due = await this.repo.dueTasks(BATCH);
    for (const t of due) await this.runOne(t.decisionId, t.warehouseId);
    return due.length;
  }

  async runOne(decisionId: string, warehouseId: string): Promise<void> {
    const { runInTransaction, logger } = this.deps;
    try {
      await runInTransaction((tx) => this.apply(tx, decisionId, warehouseId));
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      logger.warn({ err, decisionId, warehouseId }, 'quality task failed');
      await runInTransaction(async (tx) => {
        const t = await this.repo.lockTask(tx, decisionId, warehouseId);
        if (t?.status !== 'PENDING') return;
        const attempts = t.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await this.finish(tx, t, 'FAILED', 0, message, attempts);
          return;
        }
        await this.repo.updateTask(tx, decisionId, warehouseId, {
          attempts,
          lastError: message,
          nextAttemptAt: new Date(Date.now() + (BACKOFF_MS[attempts - 1] ?? 60_000)),
        });
      });
    }
  }

  private async apply(tx: Tx, decisionId: string, warehouseId: string): Promise<void> {
    const { stockRepository, stockEngine, auditService } = this.deps;
    const t = await this.repo.lockTask(tx, decisionId, warehouseId);
    if (t?.status !== 'PENDING') return;
    const q = await this.repo.batchQuality(tx, t.batchId);
    if (q !== null && q.qualityVersion > t.stateVersion) {
      await this.finish(tx, t, 'SUPERSEDED', 0, null);
      return;
    }
    const positions = await stockRepository.lockBatchPositions(tx, warehouseId, t.batchId);
    const release = t.kind === 'RELEASE';
    const moves: StockMove[] = [];
    for (const p of positions) {
      if (p.qcHold > 0)
        moves.push({
          type: release ? 'QC_RELEASE' : 'QUARANTINE',
          from: 'QC_HOLD',
          to: release ? 'AVAILABLE' : 'QUARANTINED',
          qty: p.qcHold,
          source: { id: p.id },
        });
      if (!release && p.available > 0)
        moves.push({
          type: 'QUARANTINE',
          from: 'AVAILABLE',
          to: 'QUARANTINED',
          qty: p.available,
          source: { id: p.id },
        });
    }
    const qty = moves.reduce((s, m) => s + m.qty, 0);
    if (qty === 0) {
      await this.finish(tx, t, 'NO_STOCK', 0, null);
      return;
    }
    await stockEngine.apply(tx, moves, {
      commandId: uuidv7(),
      kind: release ? 'QC_RELEASE' : 'QUARANTINE',
      refType: 'QUALITY',
      refId: t.decisionId,
      refNo: t.decisionNo,
      reason: t.reason,
      actorUserId: t.actorUserId,
      requestId: null,
      enforce: 'system',
    });
    await auditService.record(
      tx,
      { userId: t.actorUserId, ip: null, requestId: null },
      {
        action: `quality.${t.kind.toLowerCase()}_applied`,
        targetType: 'stock_batch',
        targetId: t.batchId,
        after: { decisionNo: t.decisionNo, warehouseId, qty },
        reason: t.reason,
      },
    );
    await this.finish(tx, t, 'DONE', qty, null);
  }

  private async finish(
    tx: Tx,
    t: QualityTaskRow,
    status: QualityTaskStatus,
    qtyMoved: number,
    error: string | null,
    attempts = t.attempts + 1,
  ): Promise<void> {
    await this.repo.updateTask(tx, t.decisionId, t.warehouseId, {
      status,
      qtyMoved,
      attempts,
      lastError: error,
    });
    await emitWarehouseEvent(
      tx,
      'warehouse.quality_task_updated.v1',
      {
        decisionId: t.decisionId,
        batchId: t.batchId,
        warehouseId: t.warehouseId,
        status,
        qtyMoved,
        attempts,
        error,
      },
      t.decisionId,
    );
  }

  /** QC_HOLD of this SKU is released only through quality-service. */
  isHeld(variantId: string): Promise<boolean> {
    return this.repo.isHeld(variantId);
  }

  /** Quality policy per SKU (receipt: held SKUs land in QC_HOLD). */
  async policies(variantIds: readonly string[]) {
    return this.repo.policies(variantIds);
  }

  /**
   * `warehouse.receipt_created.v1` for a receipt written in this transaction (CN + batch lines
   * with variant facts), so quality-service can project batches and auto-sample.
   */
  async publishReceipt(tx: Tx, receiptId: string, correlationId: string): Promise<void> {
    const { stockRepository, warehousesService } = this.deps;
    const r = await this.repo.receiptWithLines(tx, receiptId);
    if (r === null) return;
    const [batches, variants, warehouses, vendors] = await Promise.all([
      stockRepository.batches(
        r.lines.map((l) => l.batchId),
        tx,
      ),
      stockRepository.variants(
        r.lines.map((l) => l.variantId),
        tx,
      ),
      warehousesService.findMany([r.warehouseId]),
      stockRepository.vendorsByIds(r.vendorId === null ? [] : [r.vendorId]),
    ]);
    const b = new Map(batches.map((x) => [x.id, x]));
    const v = new Map(variants.map((x) => [x.variantId, x]));
    const ymd = (d: Date | null) => (d === null ? null : d.toISOString().slice(0, 10));
    await emitWarehouseEvent(
      tx,
      'warehouse.receipt_created.v1',
      {
        receiptId: r.id,
        cnNo: r.cnNo,
        warehouseId: r.warehouseId,
        warehouseName: warehouses[0]?.name ?? '',
        sourceType: r.sourceType,
        vendorId: r.vendorId,
        vendorName: vendors[0]?.name ?? null,
        receivedAt: r.receivedAt.toISOString(),
        receivedBy: r.receivedBy,
        lines: r.lines.flatMap((l) => {
          const batch = b.get(l.batchId);
          const variant = v.get(l.variantId);
          if (batch === undefined || variant === undefined) return [];
          return [
            {
              lineNo: l.lineNo,
              variant: {
                variantId: variant.variantId,
                productId: variant.productId,
                sku: variant.sku,
                productName: variant.name,
                variantName: variant.variantName,
                brandName: variant.brandName,
                packLabel: variant.packLabel,
                imageUrl: variant.imageUrl,
                temperatureClass: variant.temperatureClass,
              },
              batchId: l.batchId,
              batchNo: batch.batchNo,
              mfgDate: ymd(batch.mfgDate),
              expiryDate: ymd(batch.expiryDate),
              serialized: batch.serialized,
              qty: l.qty,
              initialStatus: l.initialStatus,
            },
          ];
        }),
      },
      correlationId,
    );
  }

  /** `GET /internal/wms/units/:qrCode/trace` (quality-service QR scan). null = unknown code. */
  async unitTrace(qrCode: string) {
    const u = await this.repo.unit(qrCode);
    if (u === null) return null;
    const [unitCount, receipt, shipment] = await Promise.all([
      this.repo.unitCount(u.batchId),
      this.repo.firstReceipt(u.batchId, u.warehouseId),
      u.shipmentId === null ? null : this.deps.fulfilmentQueries.shipmentTrace(u.shipmentId),
    ]);
    const names =
      receipt === null ? [] : await this.deps.warehousesService.findMany([receipt.warehouseId]);
    return {
      qrCode: u.qrCode,
      batchId: u.batchId,
      variantId: u.variantId,
      seq: u.seq,
      unitCount,
      status: u.status,
      receipt:
        receipt === null
          ? null
          : {
              cnNo: receipt.cnNo,
              warehouseId: receipt.warehouseId,
              warehouseName: names[0]?.name ?? '',
              receivedAt: receipt.receivedAt.toISOString(),
            },
      shipment,
    };
  }
}
