import { type Tx, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

export type QualityTaskStatus = 'PENDING' | 'DONE' | 'FAILED' | 'NO_STOCK' | 'SUPERSEDED';

export interface QualityTaskRow {
  decisionId: string;
  warehouseId: string;
  batchId: string;
  decisionNo: string;
  kind: string;
  stateVersion: number;
  actorUserId: string | null;
  reason: string | null;
  status: QualityTaskStatus;
  qtyMoved: number;
  attempts: number;
}

/**
 * D-60 quality side of the stock feature: SKU quality policy (event-fed), the batch read copy,
 * per-warehouse decision tasks and unit lookups for the QR trace.
 */
export class StockQualityRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── policy ──

  async policies(variantIds: readonly string[]) {
    if (variantIds.length === 0)
      return new Map<string, { holdOnReceipt: boolean; isActive: boolean }>();
    const rows = await withPrismaErrors(() =>
      this.db.wmsQualityPolicy.findMany({ where: { variantId: { in: [...new Set(variantIds)] } } }),
    );
    return new Map(rows.map((r) => [r.variantId, r]));
  }

  async isHeld(variantId: string): Promise<boolean> {
    const p = await this.db.wmsQualityPolicy.findUnique({ where: { variantId } });
    return p?.isActive === true && p.holdOnReceipt;
  }

  /** Highest version wins (out-of-order and duplicate deliveries are harmless). */
  async upsertPolicy(
    tx: Tx,
    p: {
      variantId: string;
      holdOnReceipt: boolean;
      releaseMode: string;
      isActive: boolean;
      version: number;
    },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "warehouse_quality_policies" ("variantId", "holdOnReceipt", "releaseMode", "isActive", "version", "updatedAt")
      VALUES (${p.variantId}::uuid, ${p.holdOnReceipt}, ${p.releaseMode}, ${p.isActive}, ${p.version}, now())
      ON CONFLICT ("variantId") DO UPDATE SET
        "holdOnReceipt" = EXCLUDED."holdOnReceipt", "releaseMode" = EXCLUDED."releaseMode",
        "isActive" = EXCLUDED."isActive", "version" = EXCLUDED."version", "updatedAt" = now()
      WHERE "warehouse_quality_policies"."version" < EXCLUDED."version"`;
  }

  // ── batch read copy ──

  async setCertificate(
    tx: Tx,
    batchId: string,
    certificateStatus: string,
    coaRef: string | null,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "warehouse_batches"
      SET "certificateStatus" = ${certificateStatus}::"WmsCertificateStatus", "coaRef" = ${coaRef}, "updatedAt" = now()
      WHERE "id" = ${batchId}::uuid`;
  }

  /** Newer decision only: version + blocked flag (returns false for an older / duplicate one). */
  async bumpQuality(tx: Tx, batchId: string, version: number, blocked: boolean): Promise<boolean> {
    const n = await tx.$executeRaw`
      UPDATE "warehouse_batches" SET "qualityVersion" = ${version}, "qualityBlocked" = ${blocked}, "updatedAt" = now()
      WHERE "id" = ${batchId}::uuid AND "qualityVersion" < ${version}`;
    return n > 0;
  }

  async batchQuality(tx: Tx, batchId: string) {
    const rows = await tx.$queryRaw<{ qualityVersion: number; qualityBlocked: boolean }[]>`
      SELECT "qualityVersion", "qualityBlocked" FROM "warehouse_batches" WHERE "id" = ${batchId}::uuid FOR SHARE`;
    return rows[0] ?? null;
  }

  /** Warehouses holding stock a decision would move (RELEASE: QC_HOLD; others: QC_HOLD + AVAILABLE). */
  async holders(tx: Tx, batchId: string, kind: string): Promise<string[]> {
    const rows = await tx.$queryRaw<{ warehouseId: string }[]>(
      Prisma.sql`SELECT "warehouseId" FROM "warehouse_stock_positions" WHERE "batchId" = ${batchId}::uuid
        GROUP BY "warehouseId"
        HAVING ${kind === 'RELEASE' ? Prisma.sql`sum("qcHold")` : Prisma.sql`sum("qcHold" + "available")`} > 0
        ORDER BY "warehouseId"`,
    );
    return rows.map((r) => r.warehouseId);
  }

  // ── tasks ──

  async insertTasks(tx: Tx, rows: Prisma.WmsQualityTaskCreateManyInput[]): Promise<void> {
    if (rows.length > 0) await tx.wmsQualityTask.createMany({ data: rows, skipDuplicates: true });
  }

  /** PENDING tasks whose retry time has come (oldest first). */
  dueTasks(limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsQualityTask.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        select: { decisionId: true, warehouseId: true },
        take: limit,
      }),
    );
  }

  /** Locks one task for this transaction; null when another worker holds it (SKIP LOCKED). */
  async lockTask(tx: Tx, decisionId: string, warehouseId: string): Promise<QualityTaskRow | null> {
    const rows = await tx.$queryRaw<QualityTaskRow[]>`
      SELECT "decisionId", "warehouseId", "batchId", "decisionNo", "kind", "stateVersion", "actorUserId",
        "reason", "status"::text AS "status", "qtyMoved", "attempts"
      FROM "warehouse_quality_tasks"
      WHERE "decisionId" = ${decisionId}::uuid AND "warehouseId" = ${warehouseId}::uuid
      FOR UPDATE SKIP LOCKED`;
    return rows[0] ?? null;
  }

  async updateTask(
    tx: Tx,
    decisionId: string,
    warehouseId: string,
    data: Prisma.WmsQualityTaskUncheckedUpdateInput,
  ) {
    return tx.wmsQualityTask.update({
      where: { decisionId_warehouseId: { decisionId, warehouseId } },
      data,
    });
  }

  async resetFailed(tx: Tx, decisionId: string, warehouseIds: readonly string[]): Promise<number> {
    const r = await tx.wmsQualityTask.updateMany({
      where: { decisionId, warehouseId: { in: [...warehouseIds] }, status: 'FAILED' },
      data: { status: 'PENDING', nextAttemptAt: new Date(), lastError: null },
    });
    return r.count;
  }

  // ── units / receipts (QR trace, receipt event) ──

  unit(qrCode: string) {
    return withPrismaErrors(() => this.db.wmsStockUnit.findUnique({ where: { qrCode } }));
  }

  unitCount(batchId: string) {
    return withPrismaErrors(() => this.db.wmsStockUnit.count({ where: { batchId } }));
  }

  /** The first receipt (CN) of a batch, preferring a warehouse. */
  async firstReceipt(batchId: string, warehouseId: string | null) {
    const rows = await this.db.$queryRaw<{ cnNo: string; warehouseId: string; receivedAt: Date }[]>`
      SELECT r."cnNo", r."warehouseId", r."receivedAt"
      FROM "warehouse_receipt_lines" l JOIN "warehouse_receipts" r ON r."id" = l."receiptId"
      WHERE l."batchId" = ${batchId}::uuid
      ORDER BY (r."warehouseId" = ${warehouseId}::uuid) DESC NULLS LAST, r."receivedAt"
      LIMIT 1`;
    return rows[0] ?? null;
  }

  receiptWithLines(tx: Tx, receiptId: string) {
    return tx.wmsReceipt.findUnique({
      where: { id: receiptId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
  }
}
