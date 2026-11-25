import type { Tx } from '@farmx/database';
import type { Database, Prisma } from '@farmx/database/client';

type Db = Database | Tx;

/**
 * Read-only projections of warehouse / product facts: `quality_variants`, `quality_batches`,
 * `quality_receipt_lines`, `quality_batch_buyers`. Written only by event handlers.
 */
export class ProjectionsRepository {
  constructor(private readonly deps: { db: Database }) {}

  // ── variants ──
  variant(variantId: string) {
    return this.deps.db.qaVariant.findUnique({ where: { variantId } });
  }
  variants(ids: readonly string[]) {
    return this.deps.db.qaVariant.findMany({ where: { variantId: { in: [...ids] } } });
  }
  upsertVariant(db: Db, row: Prisma.QaVariantUncheckedCreateInput) {
    return db.qaVariant.upsert({ where: { variantId: row.variantId }, create: row, update: row });
  }
  /** Keeps an existing row (lazy fetch from product-service). */
  insertVariantIfMissing(row: Prisma.QaVariantUncheckedCreateInput) {
    return this.deps.db.qaVariant.upsert({
      where: { variantId: row.variantId },
      create: row,
      update: {},
    });
  }
  async variantIdsMatching(term: string, take: number): Promise<string[]> {
    const rows = await this.deps.db.qaVariant.findMany({
      where: {
        OR: [
          { sku: { contains: term, mode: 'insensitive' } },
          { name: { contains: term, mode: 'insensitive' } },
        ],
      },
      select: { variantId: true },
      take,
    });
    return rows.map((r) => r.variantId);
  }

  // ── batches ──
  batch(batchId: string, tx?: Tx) {
    return (tx ?? this.deps.db).qaBatch.findUnique({ where: { batchId } });
  }
  batches(ids: readonly string[]) {
    return this.deps.db.qaBatch.findMany({ where: { batchId: { in: [...ids] } } });
  }
  upsertBatch(
    tx: Tx,
    create: Prisma.QaBatchUncheckedCreateInput,
    update: Prisma.QaBatchUncheckedUpdateInput,
  ) {
    return tx.qaBatch.upsert({ where: { batchId: create.batchId }, create, update });
  }
  batchesByNo(batchNo: string, f: { variantId?: string; batchIds?: string[] }) {
    return this.deps.db.qaBatch.findMany({
      where: {
        batchNo: { equals: batchNo.trim(), mode: 'insensitive' },
        ...(f.variantId === undefined ? {} : { variantId: f.variantId }),
        ...(f.batchIds === undefined ? {} : { batchId: { in: f.batchIds } }),
      },
      take: 10,
    });
  }
  async batchIdsByNoContaining(term: string): Promise<string[]> {
    const rows = await this.deps.db.qaBatch.findMany({
      where: { batchNo: { contains: term, mode: 'insensitive' } },
      select: { batchId: true },
      take: 200,
    });
    return rows.map((r) => r.batchId);
  }
  async batchIdsOfVariants(variantIds: readonly string[]): Promise<string[]> {
    if (variantIds.length === 0) return [];
    const rows = await this.deps.db.qaBatch.findMany({
      where: { variantId: { in: [...variantIds] } },
      select: { batchId: true },
      take: 500,
    });
    return rows.map((r) => r.batchId);
  }

  // ── receipt lines (CN) ──
  insertLines(tx: Tx, rows: Prisma.QaReceiptLineCreateManyInput[]) {
    return tx.qaReceiptLine.createMany({ data: rows, skipDuplicates: true });
  }
  linesOfBatches(batchIds: readonly string[], tx?: Tx) {
    return (tx ?? this.deps.db).qaReceiptLine.findMany({
      where: { batchId: { in: [...batchIds] } },
      orderBy: { receivedAt: 'asc' },
    });
  }
  latestLine(batchId: string, warehouseId: string, cnNo?: string) {
    return this.deps.db.qaReceiptLine.findFirst({
      where: { batchId, warehouseId, ...(cnNo === undefined ? {} : { cnNo }) },
      orderBy: { receivedAt: 'desc' },
    });
  }
  async batchIdsOfCn(cnNo: string): Promise<string[]> {
    const rows = await this.deps.db.qaReceiptLine.findMany({
      where: { cnNo: { equals: cnNo.trim(), mode: 'insensitive' } },
      select: { batchId: true },
      distinct: ['batchId'],
    });
    return rows.map((r) => r.batchId);
  }
  async batchIdsOfCnPrefix(prefix: string): Promise<string[]> {
    const rows = await this.deps.db.qaReceiptLine.findMany({
      where: { cnNo: { startsWith: prefix, mode: 'insensitive' } },
      select: { batchId: true },
      distinct: ['batchId'],
      take: 500,
    });
    return rows.map((r) => r.batchId);
  }
  async batchIdsInWarehouses(warehouseIds: readonly string[]): Promise<string[]> {
    const rows = await this.deps.db.qaReceiptLine.findMany({
      where: { warehouseId: { in: [...warehouseIds] } },
      select: { batchId: true },
      distinct: ['batchId'],
    });
    return rows.map((r) => r.batchId);
  }
  async receivingWarehouses(batchId: string): Promise<string[]> {
    const rows = await this.deps.db.qaReceiptLine.findMany({
      where: { batchId },
      select: { warehouseId: true },
      distinct: ['warehouseId'],
    });
    return rows.map((r) => r.warehouseId);
  }
  async unitsReceived(batchId: string): Promise<number> {
    const r = await this.deps.db.qaReceiptLine.aggregate({
      where: { batchId },
      _sum: { qty: true },
    });
    return r._sum.qty ?? 0;
  }
  async cnNosOf(batchId: string, tx?: Tx): Promise<string[]> {
    const rows = await (tx ?? this.deps.db).qaReceiptLine.findMany({
      where: { batchId },
      select: { cnNo: true },
      distinct: ['cnNo'],
    });
    return rows.map((r) => r.cnNo);
  }

  // ── buyers ──
  insertBuyers(tx: Tx, rows: Prisma.QaBatchBuyerCreateManyInput[]) {
    return tx.qaBatchBuyer.createMany({ data: rows, skipDuplicates: true });
  }
  buyersOf(tx: Tx, batchId: string) {
    return tx.qaBatchBuyer.findMany({
      where: { batchId },
      select: { customerUserId: true, orderId: true, orderNo: true },
    });
  }
  customerRows(
    customerUserId: string,
    f: { batchIds?: string[]; orderPrefix?: string },
    skip: number,
    take: number,
  ) {
    return this.deps.db.qaBatchBuyer.findMany({
      where: {
        customerUserId,
        ...(f.batchIds === undefined
          ? {}
          : {
              OR: [
                { batchId: { in: f.batchIds } },
                ...(f.orderPrefix === undefined
                  ? []
                  : [{ orderNo: { startsWith: f.orderPrefix, mode: 'insensitive' as const } }]),
              ],
            }),
      },
      orderBy: [{ dispatchedAt: 'desc' }, { shipmentId: 'desc' }, { batchId: 'asc' }],
      skip,
      take,
    });
  }
  customerRowsIn(customerUserId: string, batchIds: readonly string[]) {
    return this.deps.db.qaBatchBuyer.findMany({
      where: { customerUserId, batchId: { in: [...batchIds] } },
      orderBy: { dispatchedAt: 'desc' },
    });
  }
}
