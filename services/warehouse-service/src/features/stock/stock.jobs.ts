import type { Cradle } from '@fastify/awilix';
import { uuidv7 } from '../../adapters/uuid.js';
import type { StockMove } from './stock.engine.js';

/** IST calendar day as a UTC-midnight Date (matches `@db.Date` columns). */
const istToday = (): Date => {
  const ist = new Date(Date.now() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
};

export interface ReconcileReport {
  at: string;
  mode: string;
  stockMismatches: {
    warehouseId: string;
    variantId: string;
    wms: { sellable: number; damaged: number };
    inventory: { onHand: number; damaged: number };
  }[];
  unitMismatches: {
    batchId: string;
    warehouseId: string;
    status: string;
    units: number;
    column: number;
  }[];
}

/**
 * Stock jobs (D-57a): expiry (daily), reconcile (nightly) — run by the BullMQ runtime with the
 * failure policy (5 tries → dead-letter → alert).
 */
export class StockJobs {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'stockRepository'
      | 'stockEngine'
      | 'stockSettings'
      | 'inventoryClient'
      | 'runInTransaction'
      | 'logger'
    >,
  ) {}

  /** AVAILABLE units past expiry → EXPIRED (system move, tells inventory); near-expiry totals. */
  async expire(): Promise<{ positions: number; units: number }> {
    if ((await this.deps.stockSettings.writesMode()) !== 'WMS') return { positions: 0, units: 0 };
    const today = istToday();
    const ids = await this.deps.stockRepository.expiredAvailable(today, 500);
    let units = 0;
    for (const id of ids)
      units += await this.deps.runInTransaction(async (tx) => {
        const [p] = await this.deps.stockRepository.lockPositions(tx, [id]);
        if (p === undefined || p.available <= 0 || p.expiryDate === null || p.expiryDate >= today)
          return 0;
        const move: StockMove = {
          type: 'EXPIRE',
          from: 'AVAILABLE',
          to: 'EXPIRED',
          qty: p.available,
          source: { id },
        };
        await this.deps.stockEngine.apply(tx, [move], {
          commandId: uuidv7(),
          kind: 'EXPIRE',
          refType: 'EXPIRY',
          refId: p.batchId,
          refNo: null,
          reason: 'Expiry reached',
          actorUserId: null,
          requestId: null,
          enforce: 'system',
        });
        return p.available;
      });
    const days = await this.deps.stockSettings.get('stock.nearExpiryDays');
    await this.deps.stockRepository.refreshNearExpiry(today, days);
    return { positions: ids.length, units };
  }

  /** WMS sellable / damaged vs inventory; unit QR vs columns (serialized batches). */
  async reconcile(): Promise<ReconcileReport> {
    const mode = await this.deps.stockSettings.writesMode();
    const report: ReconcileReport = {
      at: new Date().toISOString(),
      mode,
      stockMismatches: [],
      unitMismatches: [],
    };
    if (mode === 'WMS') {
      const levels: Awaited<ReturnType<Cradle['inventoryClient']['snapshot']>> = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await this.deps.inventoryClient.snapshot(cursor);
        levels.push(...page);
        if (page.length < 2000) break;
        cursor = page.at(-1)?.id;
      }
      const wms = new Map(
        (await this.deps.stockRepository.summaryTotals()).map((r) => [
          `${r.warehouseId}|${r.variantId}`,
          r,
        ]),
      );
      const seen = new Set<string>();
      for (const l of levels) {
        const key = `${l.warehouseId}|${l.variantId}`;
        seen.add(key);
        const w = wms.get(key) ?? { sellable: 0, damaged: 0 };
        if (w.sellable !== l.onHand || w.damaged !== l.damaged)
          report.stockMismatches.push({
            warehouseId: l.warehouseId,
            variantId: l.variantId,
            wms: { sellable: w.sellable, damaged: w.damaged },
            inventory: { onHand: l.onHand, damaged: l.damaged },
          });
      }
      for (const [key, w] of wms)
        if (!seen.has(key) && (w.sellable !== 0 || w.damaged !== 0)) {
          const [warehouseId, variantId] = key.split('|') as [string, string];
          report.stockMismatches.push({
            warehouseId,
            variantId,
            wms: w,
            inventory: { onHand: 0, damaged: 0 },
          });
        }
    }
    report.unitMismatches = await this.deps.stockRepository.unitMismatches(200);
    await this.deps.runInTransaction(async (tx) => {
      await this.deps.stockRepository.setSetting(tx, 'stock.reconcileReport', report, null);
    });
    if (report.stockMismatches.length > 0 || report.unitMismatches.length > 0)
      this.deps.logger.error(
        { stock: report.stockMismatches.length, units: report.unitMismatches.length },
        'stock reconcile found drift',
      );
    return report;
  }
}
