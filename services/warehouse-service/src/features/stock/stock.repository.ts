import { type Tx, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';
import { uuidv7 } from '../../adapters/uuid.js';
import type { Column, OwnerType, Quantities, StockStatus } from './stock.rules.js';

type Db = Cradle['db'];

export interface PositionDims {
  warehouseId: string;
  variantId: string;
  batchId: string;
  binId: string | null;
  ownerType: OwnerType;
  vendorId: string | null;
}

export interface PositionRow extends PositionDims, Quantities {
  id: string;
  expiryDate: Date | null;
  receivedAt: Date;
  reviewFields: string[];
  version: number;
}

export interface MovementInsert {
  warehouseId: string;
  variantId: string;
  batchId: string;
  binId: string | null;
  ownerType: OwnerType;
  type: Prisma.WmsStockMovementCreateManyInput['type'];
  fromStatus: StockStatus | null;
  toStatus: StockStatus | null;
  qty: number;
  sellableDelta: number;
  damagedDelta: number;
  refType: string;
  refId: string | null;
  refNo: string | null;
  reason: string | null;
  actorUserId: string | null;
  requestId: string | null;
}

export const BATCH = {
  id: true,
  variantId: true,
  batchNo: true,
  mfgDate: true,
  expiryDate: true,
  vendorId: true,
  coaRef: true,
  coaMediaKey: true,
  certificateStatus: true,
  qualityNote: true,
  isOpening: true,
  serialized: true,
  createdAt: true,
} as const satisfies Prisma.WmsBatchSelect;
export type BatchRow = Prisma.WmsBatchGetPayload<{ select: typeof BATCH }>;

export const VARIANT = {
  variantId: true,
  productId: true,
  sku: true,
  name: true,
  variantName: true,
  brandId: true,
  brandName: true,
  categoryId: true,
  categoryPath: true,
  rootCategoryId: true,
  packLabel: true,
  weightGrams: true,
  temperatureClass: true,
  shelfLifeMonths: true,
  imageUrl: true,
  isPrescriptionRequired: true,
  drugSchedule: true,
  isAntimicrobial: true,
  hazardClass: true,
  isActive: true,
  version: true,
} as const satisfies Prisma.WmsVariantProjectionSelect;
export type VariantRow = Prisma.WmsVariantProjectionGetPayload<{ select: typeof VARIANT }>;

const POSITION_COLS = `"id","warehouseId","variantId","batchId","binId","ownerType","vendorId","qcHold","available","reserved","picked","packed","quarantined","damaged","expired","returned","expiryDate","receivedAt","reviewFields","version"`;

/** Only place that touches the stock tables (positions, summary, ledger, units, batches …). */
export class StockRepository {
  private readonly db: Db;

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── settings / sequences ──

  settings(keys: readonly string[], scope = 'GLOBAL', tx?: Tx) {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsSetting.findMany({
        where: { key: { in: [...keys] }, scope: { in: [scope, 'GLOBAL'] } },
        select: { key: true, scope: true, value: true, version: true, updatedAt: true },
      }),
    );
  }

  async setSetting(tx: Tx, key: string, value: unknown, userId: string | null, scope = 'GLOBAL') {
    await tx.wmsSetting.upsert({
      where: { key_scope: { key, scope } },
      create: { key, scope, value: value as Prisma.InputJsonValue, updatedByUserId: userId },
      update: {
        value: value as Prisma.InputJsonValue,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
      select: { key: true },
    });
  }

  /** Next number of a document sequence (row lock on the counter). */
  async nextSeq(tx: Tx, kind: string, period: number): Promise<number> {
    const rows = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO "warehouse_sequences" ("kind", "period", "last") VALUES (${kind}, ${period}, 1)
      ON CONFLICT ("kind", "period") DO UPDATE SET "last" = "warehouse_sequences"."last" + 1
      RETURNING "last"`;
    return rows[0]?.last ?? 1;
  }

  // ── variant projection ──

  variants(ids: readonly string[], tx?: Tx): Promise<VariantRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsVariantProjection.findMany({
        where: { variantId: { in: [...new Set(ids)] } },
        select: VARIANT,
      }),
    );
  }

  /** Version-guarded upsert (older or duplicate facts are ignored). */
  async upsertVariant(
    tx: Tx,
    row: Omit<Prisma.WmsVariantProjectionUncheckedCreateInput, 'updatedAt'>,
  ): Promise<void> {
    const current = await tx.wmsVariantProjection.findUnique({
      where: { variantId: row.variantId },
      select: { version: true },
    });
    if (current !== null && current.version >= BigInt(row.version ?? -1)) return;
    await tx.wmsVariantProjection.upsert({
      where: { variantId: row.variantId },
      create: row,
      update: row,
      select: { variantId: true },
    });
  }

  async deactivateVariant(tx: Tx, variantId: string, version: number): Promise<void> {
    await tx.wmsVariantProjection.updateMany({
      where: { variantId, version: { lt: BigInt(version) } },
      data: { isActive: false, version: BigInt(version) },
    });
  }

  searchVariants(q: string, limit: number): Promise<VariantRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsVariantProjection.findMany({
        where: { searchText: { contains: q.toLowerCase() } },
        select: VARIANT,
        orderBy: { sku: 'asc' },
        take: limit,
      }),
    );
  }

  // ── batches ──

  batch(id: string, tx?: Tx): Promise<BatchRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsBatch.findUnique({ where: { id }, select: BATCH }),
    );
  }

  batches(ids: readonly string[], tx?: Tx): Promise<BatchRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsBatch.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: BATCH,
      }),
    );
  }

  batchByNo(variantId: string, batchNo: string, tx?: Tx): Promise<BatchRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsBatch.findUnique({
        where: { variantId_batchNo: { variantId, batchNo } },
        select: BATCH,
      }),
    );
  }

  async createBatch(tx: Tx, data: Prisma.WmsBatchUncheckedCreateInput): Promise<BatchRow> {
    return tx.wmsBatch.create({ data, select: BATCH });
  }

  async updateBatch(tx: Tx, id: string, data: Prisma.WmsBatchUncheckedUpdateInput) {
    return tx.wmsBatch.update({ where: { id }, data, select: BATCH });
  }

  // ── positions ──

  /** Id of the position with these dimensions (created empty when missing). */
  async ensurePosition(
    tx: Tx,
    d: PositionDims,
    extra: { expiryDate: Date | null; reviewFields?: string[] },
  ): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO "warehouse_stock_positions"
        ("id", "warehouseId", "variantId", "batchId", "binId", "ownerType", "vendorId",
         "expiryDate", "reviewFields", "receivedAt", "updatedAt")
      VALUES (${uuidv7()}::uuid, ${d.warehouseId}::uuid, ${d.variantId}::uuid, ${d.batchId}::uuid,
        ${d.binId}::uuid, ${d.ownerType}::"WmsOwnerType", ${d.vendorId}::uuid,
        ${extra.expiryDate}::date, ${extra.reviewFields ?? []}::text[], now(), now())
      ON CONFLICT ("warehouseId", "batchId", "binId", "ownerType", "vendorId") DO NOTHING`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "warehouse_stock_positions"
      WHERE "warehouseId" = ${d.warehouseId}::uuid AND "batchId" = ${d.batchId}::uuid
        AND "binId" IS NOT DISTINCT FROM ${d.binId}::uuid
        AND "ownerType" = ${d.ownerType}::"WmsOwnerType"
        AND "vendorId" IS NOT DISTINCT FROM ${d.vendorId}::uuid`;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('position upsert returned no row');
    return id;
  }

  /** Row locks in id order (no deadlocks between concurrent commands). */
  lockPositions(tx: Tx, ids: readonly string[]): Promise<PositionRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return tx.$queryRaw<PositionRow[]>(
      Prisma.sql`SELECT ${Prisma.raw(POSITION_COLS)} FROM "warehouse_stock_positions"
        WHERE "id" = ANY(${[...new Set(ids)]}::uuid[]) ORDER BY "id" FOR UPDATE`,
    );
  }

  position(id: string, tx?: Tx): Promise<PositionRow | null> {
    return withPrismaErrors(
      () =>
        (tx ?? this.db).wmsStockPosition.findUnique({
          where: { id },
        }) as Promise<PositionRow | null>,
    );
  }

  /** Positions of a batch at a warehouse (optionally one bin), locked. */
  async lockBatchPositions(
    tx: Tx,
    warehouseId: string,
    batchId: string,
    binId?: string | null,
  ): Promise<PositionRow[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "warehouse_stock_positions"
        WHERE "warehouseId" = ${warehouseId}::uuid AND "batchId" = ${batchId}::uuid
        ${binId === undefined ? Prisma.empty : Prisma.sql`AND "binId" IS NOT DISTINCT FROM ${binId}::uuid`}`,
    );
    return this.lockPositions(
      tx,
      rows.map((r) => r.id),
    );
  }

  async applyPosition(tx: Tx, id: string, delta: Partial<Record<Column, number>>): Promise<void> {
    const data: Record<string, unknown> = { version: { increment: 1 } };
    for (const [col, n] of Object.entries(delta)) if (n !== 0) data[col] = { increment: n };
    await tx.wmsStockPosition.update({ where: { id }, data, select: { id: true } });
  }

  async setReviewFields(tx: Tx, id: string, fields: string[]): Promise<void> {
    await tx.wmsStockPosition.update({
      where: { id },
      data: { reviewFields: fields },
      select: { id: true },
    });
  }

  async applySummary(
    tx: Tx,
    warehouseId: string,
    variantId: string,
    delta: Partial<Record<Column, number>>,
    expiryUnknownDelta: number,
  ): Promise<void> {
    const create: Record<string, unknown> = { warehouseId, variantId, lastMovementAt: new Date() };
    const update: Record<string, unknown> = { lastMovementAt: new Date() };
    for (const [col, n] of Object.entries(delta)) {
      if (n === 0) continue;
      create[col] = n;
      update[col] = { increment: n };
    }
    if (expiryUnknownDelta !== 0) {
      create.expiryUnknown = expiryUnknownDelta;
      update.expiryUnknown = { increment: expiryUnknownDelta };
    }
    await tx.wmsStockSummary.upsert({
      where: { warehouseId_variantId: { warehouseId, variantId } },
      create: create as Prisma.WmsStockSummaryUncheckedCreateInput,
      update,
      select: { warehouseId: true },
    });
  }

  async insertMovements(tx: Tx, rows: readonly MovementInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.wmsStockMovement.createMany({ data: rows.map((r) => ({ ...r })) });
  }

  // ── unit QR (serialized batches) ──

  async maxUnitSeq(tx: Tx, batchId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ max: number | null }[]>`
      SELECT max("seq") AS "max" FROM "warehouse_stock_units" WHERE "batchId" = ${batchId}::uuid`;
    return rows[0]?.max ?? 0;
  }

  async countUnits(batchId: string, warehouseId: string, tx?: Tx): Promise<number> {
    return (tx ?? this.db).wmsStockUnit.count({ where: { batchId, warehouseId } });
  }

  /** New unit rows `prefix + seq` for seq in [from, from + qty). */
  async generateUnits(
    tx: Tx,
    u: {
      prefix: string;
      from: number;
      qty: number;
      batchId: string;
      variantId: string;
      warehouseId: string;
      binId: string | null;
      ownerType: OwnerType;
      status: StockStatus;
    },
  ): Promise<void> {
    if (u.qty <= 0) return;
    await tx.$executeRaw`
      INSERT INTO "warehouse_stock_units"
        ("qrCode", "batchId", "variantId", "warehouseId", "binId", "status", "seq", "ownerType",
         "generatedAt", "lastEventAt")
      SELECT ${u.prefix} || CASE WHEN g < 10000 THEN lpad(g::text, 4, '0') ELSE g::text END,
        ${u.batchId}::uuid, ${u.variantId}::uuid, ${u.warehouseId}::uuid, ${u.binId}::uuid,
        ${u.status}::"WmsStockStatus", g, ${u.ownerType}::"WmsOwnerType", now(), now()
      FROM generate_series(${u.from}::int, ${u.from + u.qty - 1}::int) AS g`;
  }

  /** Move `qty` units (lowest seq first) of one position + status; returns how many moved. */
  moveUnits(
    tx: Tx,
    u: {
      batchId: string;
      warehouseId: string | null;
      binId: string | null;
      ownerType: OwnerType;
      from: StockStatus;
      to: StockStatus;
      qty: number;
      toWarehouseId: string | null;
      toBinId: string | null;
      toOwnerType: OwnerType;
      shipmentId?: string | null;
    },
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE "warehouse_stock_units" SET "status" = ${u.to}::"WmsStockStatus",
        "warehouseId" = ${u.toWarehouseId}::uuid, "binId" = ${u.toBinId}::uuid,
        "ownerType" = ${u.toOwnerType}::"WmsOwnerType",
        "shipmentId" = COALESCE(${u.shipmentId ?? null}::uuid, "shipmentId"), "lastEventAt" = now()
      WHERE "qrCode" IN (
        SELECT "qrCode" FROM "warehouse_stock_units"
        WHERE "batchId" = ${u.batchId}::uuid
          AND "warehouseId" IS NOT DISTINCT FROM ${u.warehouseId}::uuid
          AND "binId" IS NOT DISTINCT FROM ${u.binId}::uuid
          AND "ownerType" = ${u.ownerType}::"WmsOwnerType" AND "status" = ${u.from}::"WmsStockStatus"
        ORDER BY "seq" LIMIT ${u.qty} FOR UPDATE)`;
  }

  positionsByIds(ids: readonly string[]): Promise<PositionRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(
      () =>
        this.db.wmsStockPosition.findMany({ where: { id: { in: [...new Set(ids)] } } }) as Promise<
          PositionRow[]
        >,
    );
  }

  /** Vendor ↔ SKU supply rows for some SKUs (ownership model, unit QR flag). */
  vendorSupply(variantIds: readonly string[]) {
    return withPrismaErrors(() =>
      this.db.wmsVendorVariant.findMany({
        where: { variantId: { in: [...new Set(variantIds)] } },
        select: {
          vendorId: true,
          variantId: true,
          ownershipModel: true,
          requiresUnitQr: true,
          isPreferred: true,
          leadTimeDays: true,
        },
      }),
    );
  }

  // ── receipts ──

  receiptByKey(idempotencyKey: string) {
    return withPrismaErrors(() =>
      this.db.wmsReceipt.findUnique({ where: { idempotencyKey }, select: { id: true } }),
    );
  }

  async createReceipt(
    tx: Tx,
    r: Omit<Prisma.WmsReceiptUncheckedCreateInput, 'lines'> & {
      id: string;
      lines: Omit<Prisma.WmsReceiptLineCreateManyInput, 'receiptId'>[];
    },
  ): Promise<void> {
    const { lines, ...head } = r;
    await tx.wmsReceipt.create({ data: head, select: { id: true } });
    await tx.wmsReceiptLine.createMany({ data: lines.map((l) => ({ ...l, receiptId: r.id })) });
  }

  receipt(id: string) {
    return withPrismaErrors(() =>
      this.db.wmsReceipt.findUnique({
        where: { id },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
      }),
    );
  }

  receipts(
    scope: 'ALL' | readonly string[],
    q: { warehouseId?: string; cursor?: string; limit: number },
  ) {
    return withPrismaErrors(() =>
      this.db.wmsReceipt.findMany({
        where: {
          ...(q.warehouseId !== undefined
            ? { warehouseId: q.warehouseId }
            : scope === 'ALL'
              ? {}
              : { warehouseId: { in: [...scope] } }),
          ...(q.cursor === undefined ? {} : { id: { lt: q.cursor } }),
        },
        select: {
          id: true,
          cnNo: true,
          warehouseId: true,
          sourceType: true,
          vendorId: true,
          receivedAt: true,
          _count: { select: { lines: true } },
        },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      }),
    );
  }

  // ── adjustments ──

  adjustmentByKey(idempotencyKey: string) {
    return withPrismaErrors(() =>
      this.db.wmsStockAdjustment.findUnique({ where: { idempotencyKey }, select: { id: true } }),
    );
  }

  createAdjustment(tx: Tx, data: Prisma.WmsStockAdjustmentUncheckedCreateInput) {
    return tx.wmsStockAdjustment.create({ data, select: { id: true } });
  }

  adjustment(id: string) {
    return withPrismaErrors(() => this.db.wmsStockAdjustment.findUnique({ where: { id } }));
  }

  /** false when the version moved on (someone else decided first). */
  async decideAdjustment(
    tx: Tx,
    id: string,
    version: number,
    data: Prisma.WmsStockAdjustmentUncheckedUpdateManyInput,
  ): Promise<boolean> {
    const r = await tx.wmsStockAdjustment.updateMany({
      where: { id, version, status: 'PENDING_APPROVAL' },
      data: { ...data, version: { increment: 1 } },
    });
    return r.count === 1;
  }

  adjustments(
    scope: 'ALL' | readonly string[],
    q: { warehouseId?: string; status?: string; cursor?: string; limit: number },
  ) {
    return withPrismaErrors(() =>
      this.db.wmsStockAdjustment.findMany({
        where: {
          ...(q.warehouseId !== undefined
            ? { warehouseId: q.warehouseId }
            : scope === 'ALL'
              ? {}
              : { warehouseId: { in: [...scope] } }),
          ...(q.status === undefined
            ? {}
            : { status: q.status as Prisma.WmsStockAdjustmentWhereInput['status'] }),
          ...(q.cursor === undefined ? {} : { id: { lt: q.cursor } }),
        },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      }),
    );
  }

  // ── thresholds ──

  threshold(warehouseId: string, variantId: string) {
    return withPrismaErrors(() =>
      this.db.wmsStockThreshold.findUnique({
        where: { warehouseId_variantId: { warehouseId, variantId } },
      }),
    );
  }

  upsertThreshold(
    tx: Tx,
    warehouseId: string,
    r: { variantId: string; safetyStock: number; reorderLevel: number; targetStock: number },
    userId: string | null,
  ) {
    const values = {
      safetyStock: r.safetyStock,
      reorderLevel: r.reorderLevel,
      targetStock: r.targetStock,
      updatedByUserId: userId,
    };
    return tx.wmsStockThreshold.upsert({
      where: { warehouseId_variantId: { warehouseId, variantId: r.variantId } },
      create: { warehouseId, variantId: r.variantId, ...values, version: 1 },
      update: { ...values, version: { increment: 1 } },
    });
  }

  // ── lifecycle proposals ──

  createProposal(tx: Tx, data: Prisma.WmsTransitionProposalUncheckedCreateInput) {
    return tx.wmsTransitionProposal.create({ data });
  }

  proposal(id: string, tx?: Tx) {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsTransitionProposal.findUnique({ where: { id } }),
    );
  }

  proposals(q: { status?: string; cursor?: string; limit: number }) {
    return withPrismaErrors(() =>
      this.db.wmsTransitionProposal.findMany({
        where: {
          ...(q.status === undefined
            ? {}
            : { status: q.status as Prisma.WmsTransitionProposalWhereInput['status'] }),
          ...(q.cursor === undefined ? {} : { id: { lt: q.cursor } }),
        },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      }),
    );
  }

  async decideProposal(
    tx: Tx,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    by: string,
    note: string | null,
  ): Promise<boolean> {
    const r = await tx.wmsTransitionProposal.updateMany({
      where: { id, status: 'PENDING' },
      data: { status, decidedBy: by, decidedAt: new Date(), decisionNote: note },
    });
    return r.count === 1;
  }

  async applyProposal(
    tx: Tx,
    p: {
      from: StockStatus;
      to: StockStatus;
      add: boolean;
      requiredEvent: string;
      roleLabel: string;
      permissionKey: string | null;
    },
  ): Promise<void> {
    const where = { fromStatus_toStatus: { fromStatus: p.from, toStatus: p.to } };
    if (!p.add) {
      await tx.wmsStatusTransition.updateMany({
        where: { fromStatus: p.from, toStatus: p.to },
        data: { isActive: false, version: { increment: 1 } },
      });
      return;
    }
    await tx.wmsStatusTransition.upsert({
      where,
      create: {
        fromStatus: p.from,
        toStatus: p.to,
        requiredEvent: p.requiredEvent,
        roleLabel: p.roleLabel,
        permissionKey: p.permissionKey,
        systemOnly: p.permissionKey === null,
        sortOrder: 900,
      },
      update: {
        requiredEvent: p.requiredEvent,
        roleLabel: p.roleLabel,
        permissionKey: p.permissionKey,
        systemOnly: p.permissionKey === null,
        isActive: true,
        version: { increment: 1 },
      },
    });
  }

  // ── lifecycle ──

  transitions(tx?: Tx) {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsStatusTransition.findMany({
        orderBy: [{ sortOrder: 'asc' }, { fromStatus: 'asc' }],
      }),
    );
  }
}
