import { type Tx, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { ShipmentStatus } from './fulfilment.rules.js';

const SHIPMENT = {
  lines: { orderBy: { lineNo: 'asc' } },
} as const satisfies Prisma.WmsShipmentInclude;
export type ShipmentRow = Prisma.WmsShipmentGetPayload<{ include: typeof SHIPMENT }>;
export type OrderRow = Prisma.WmsFulfilmentOrderGetPayload<{
  include: { lines: { orderBy: { lineNo: 'asc' } } };
}>;
export type AllocationRow = Prisma.WmsLotAllocationGetPayload<object>;
export type TaskRow = Prisma.WmsTaskGetPayload<object>;
export type HoldRow = Prisma.WmsHoldGetPayload<object>;
export type ExceptionRow = Prisma.WmsExceptionGetPayload<object>;
export type ReallocationRow = Prisma.WmsReallocationGetPayload<object>;
export type ShelfLifeRuleRow = Prisma.WmsShelfLifeRuleGetPayload<object>;
/** Types services may use without importing the database client. */
export type JsonInput = Prisma.InputJsonValue;
export type ShipmentUpdate = Prisma.WmsShipmentUncheckedUpdateInput;

/** Daily counter columns (W3.01 rollups). */
export type DailyField =
  | 'received'
  | 'released'
  | 'dispatched'
  | 'onTimeDispatch'
  | 'delivered'
  | 'onTimeDelivery'
  | 'fulfilled'
  | 'cancelled'
  | 'qcFirst'
  | 'qcTotal'
  | 'exceptionsOpened'
  | 'pickToPackCount';

/** Only place that writes the fulfilment tables (orders read model, shipments, floor, saga). */
export class FulfilmentRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── orders read model ──

  order(orderId: string, tx?: Tx): Promise<OrderRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsFulfilmentOrder.findUnique({
        where: { orderId },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
      }),
    );
  }

  async lockOrder(tx: Tx, orderId: string): Promise<OrderRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_orders" WHERE "orderId" = ${orderId}::uuid FOR UPDATE`;
    return this.order(orderId, tx);
  }

  async upsertOrder(
    tx: Tx,
    orderId: string,
    create: Omit<Prisma.WmsFulfilmentOrderUncheckedCreateInput, 'orderId'>,
    update: Prisma.WmsFulfilmentOrderUncheckedUpdateInput,
  ): Promise<void> {
    await tx.wmsFulfilmentOrder.upsert({
      where: { orderId },
      create: { orderId, ...create },
      update: { ...update, version: { increment: 1 } },
      select: { orderId: true },
    });
  }

  async updateOrder(tx: Tx, orderId: string, data: Prisma.WmsFulfilmentOrderUncheckedUpdateInput) {
    await tx.wmsFulfilmentOrder.update({
      where: { orderId },
      data: { ...data, version: { increment: 1 } },
      select: { orderId: true },
    });
  }

  async replaceOrderLines(
    tx: Tx,
    orderId: string,
    lines: Omit<Prisma.WmsFulfilmentOrderLineCreateManyInput, 'orderId'>[],
  ): Promise<void> {
    await tx.wmsFulfilmentOrderLine.deleteMany({ where: { orderId } });
    if (lines.length > 0)
      await tx.wmsFulfilmentOrderLine.createMany({ data: lines.map((l) => ({ ...l, orderId })) });
  }

  ordersNeedingFacts(limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsFulfilmentOrder.findMany({
        where: { factsLoaded: false },
        select: { orderId: true },
        orderBy: { placedAt: 'asc' },
        take: limit,
      }),
    );
  }

  // ── shipments ──

  shipment(id: string, tx?: Tx): Promise<ShipmentRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsShipment.findUnique({ where: { id }, include: SHIPMENT }),
    );
  }

  shipmentByNo(shipmentNo: string): Promise<ShipmentRow | null> {
    return withPrismaErrors(() =>
      this.db.wmsShipment.findUnique({ where: { shipmentNo }, include: SHIPMENT }),
    );
  }

  shipmentsOfOrder(orderId: string, tx?: Tx): Promise<ShipmentRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsShipment.findMany({
        where: { orderId },
        include: SHIPMENT,
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  shipmentsByIds(ids: readonly string[]): Promise<ShipmentRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsShipment.findMany({ where: { id: { in: [...new Set(ids)] } }, include: SHIPMENT }),
    );
  }

  async lockShipment(tx: Tx, id: string): Promise<ShipmentRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_shipments" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.shipment(id, tx);
  }

  /** Locks every shipment of an order (id order: no deadlocks). */
  async lockOrderShipments(tx: Tx, orderId: string): Promise<ShipmentRow[]> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_shipments" WHERE "orderId" = ${orderId}::uuid ORDER BY "id" FOR UPDATE`;
    return this.shipmentsOfOrder(orderId, tx);
  }

  async createShipment(
    tx: Tx,
    data: Prisma.WmsShipmentUncheckedCreateInput,
    lines: Omit<Prisma.WmsShipmentLineCreateManyInput, 'shipmentId'>[],
  ): Promise<ShipmentRow> {
    const s = await tx.wmsShipment.create({ data, select: { id: true } });
    if (lines.length > 0)
      await tx.wmsShipmentLine.createMany({ data: lines.map((l) => ({ ...l, shipmentId: s.id })) });
    const row = await this.shipment(s.id, tx);
    if (row === null) throw new Error('shipment vanished');
    return row;
  }

  async updateShipment(tx: Tx, id: string, data: Prisma.WmsShipmentUncheckedUpdateInput) {
    await tx.wmsShipment.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      select: { id: true },
    });
  }

  async updateLine(
    tx: Tx,
    shipmentId: string,
    lineNo: number,
    data: Prisma.WmsShipmentLineUncheckedUpdateInput,
  ) {
    await tx.wmsShipmentLine.update({
      where: { shipmentId_lineNo: { shipmentId, lineNo } },
      data,
      select: { shipmentId: true },
    });
  }

  async addLine(tx: Tx, data: Prisma.WmsShipmentLineUncheckedCreateInput) {
    await tx.wmsShipmentLine.create({ data, select: { shipmentId: true } });
  }

  /** Every shipment of the order, small (event snapshot). */
  orderSnapshot(orderId: string, tx: Tx) {
    return tx.wmsShipment.findMany({
      where: { orderId },
      select: {
        id: true,
        warehouseId: true,
        status: true,
        version: true,
        lines: { select: { orderLineNo: true, variantId: true, deliveredQty: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── lot allocations ──

  allocations(shipmentId: string, tx?: Tx): Promise<AllocationRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsLotAllocation.findMany({
        where: { shipmentId },
        orderBy: [{ lineNo: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  allocation(id: string): Promise<AllocationRow | null> {
    return withPrismaErrors(() => this.db.wmsLotAllocation.findUnique({ where: { id } }));
  }

  async createAllocations(tx: Tx, rows: Prisma.WmsLotAllocationUncheckedCreateInput[]) {
    if (rows.length > 0) await tx.wmsLotAllocation.createMany({ data: rows });
  }

  async updateAllocation(tx: Tx, id: string, data: Prisma.WmsLotAllocationUncheckedUpdateInput) {
    await tx.wmsLotAllocation.update({ where: { id }, data, select: { id: true } });
  }

  /** Soft (held order) ALLOCATED rows of a SKU at a warehouse, oldest hold first (§2a.6). */
  softAllocations(tx: Tx, warehouseId: string, variantId: string) {
    return tx.wmsLotAllocation.findMany({
      where: { warehouseId, variantId, status: 'ALLOCATED', soft: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async markSoft(tx: Tx, shipmentIds: readonly string[], soft: boolean) {
    await tx.wmsLotAllocation.updateMany({
      where: { shipmentId: { in: [...shipmentIds] }, status: 'ALLOCATED' },
      data: { soft },
    });
  }

  /** Σ soft-held qty of a SKU at a warehouse (hold cap). */
  async softHeldQty(tx: Tx, warehouseId: string, variantId: string): Promise<number> {
    const r = await tx.wmsLotAllocation.aggregate({
      where: { warehouseId, variantId, status: 'ALLOCATED', soft: true },
      _sum: { qty: true },
    });
    return r._sum.qty ?? 0;
  }

  // ── timeline ──

  async addEvent(tx: Tx, row: Prisma.WmsShipmentEventUncheckedCreateInput) {
    await tx.wmsShipmentEvent.create({ data: row, select: { id: true } });
  }

  eventsOfOrder(orderId: string, after: string | null, limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsShipmentEvent.findMany({
        where: { orderId, ...(after === null ? {} : { id: { lt: after } }) },
        orderBy: { id: 'desc' },
        take: limit + 1,
      }),
    );
  }

  // ── tasks + pick batches ──

  task(id: string, tx?: Tx): Promise<TaskRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).wmsTask.findUnique({ where: { id } }));
  }

  async lockTask(tx: Tx, id: string): Promise<TaskRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_tasks" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.task(id, tx);
  }

  openTaskOf(tx: Tx, shipmentId: string): Promise<TaskRow | null> {
    return tx.wmsTask.findFirst({
      where: { shipmentId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  tasksOfShipments(shipmentIds: readonly string[]): Promise<TaskRow[]> {
    if (shipmentIds.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsTask.findMany({
        where: { shipmentId: { in: [...new Set(shipmentIds)] }, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  createTask(tx: Tx, data: Prisma.WmsTaskUncheckedCreateInput): Promise<TaskRow> {
    return tx.wmsTask.create({ data });
  }

  updateTask(tx: Tx, id: string, data: Prisma.WmsTaskUncheckedUpdateInput): Promise<TaskRow> {
    return tx.wmsTask.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  async cancelTasks(tx: Tx, shipmentId: string) {
    await tx.wmsTask.updateMany({
      where: { shipmentId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });
  }

  tasks(q: {
    warehouseIds: readonly string[] | 'ALL';
    assigneeUserId?: string;
    status?: string;
    pickBatchId?: string;
    cursor?: string;
    limit: number;
  }) {
    return withPrismaErrors(() =>
      this.db.wmsTask.findMany({
        where: {
          ...(q.warehouseIds === 'ALL' ? {} : { warehouseId: { in: [...q.warehouseIds] } }),
          ...(q.assigneeUserId === undefined ? {} : { assigneeUserId: q.assigneeUserId }),
          ...(q.status === undefined
            ? { status: { in: ['OPEN', 'IN_PROGRESS'] } }
            : { status: q.status as TaskRow['status'] }),
          ...(q.pickBatchId === undefined ? {} : { pickBatchId: q.pickBatchId }),
          ...(q.cursor === undefined ? {} : { id: { lt: q.cursor } }),
        },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      }),
    );
  }

  /** Open task count per assignee at a warehouse (operator load). */
  async openTaskLoad(warehouseId: string): Promise<Map<string, number>> {
    const rows = await withPrismaErrors(() =>
      this.db.wmsTask.groupBy({
        by: ['assigneeUserId'],
        where: { warehouseId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
        _count: { _all: true },
      }),
    );
    return new Map(
      rows.flatMap((r) => (r.assigneeUserId === null ? [] : [[r.assigneeUserId, r._count._all]])),
    );
  }

  createPickBatch(tx: Tx, data: Prisma.WmsPickBatchUncheckedCreateInput) {
    return tx.wmsPickBatch.create({ data });
  }

  pickBatch(id: string) {
    return withPrismaErrors(() => this.db.wmsPickBatch.findUnique({ where: { id } }));
  }

  openPickBatch(warehouseIds: readonly string[] | 'ALL') {
    return withPrismaErrors(() =>
      this.db.wmsPickBatch.findFirst({
        where: {
          status: 'OPEN',
          ...(warehouseIds === 'ALL' ? {} : { warehouseId: { in: [...warehouseIds] } }),
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async closePickBatchIfDone(tx: Tx, batchId: string) {
    const open = await tx.wmsTask.count({
      where: { pickBatchId: batchId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    });
    if (open === 0)
      await tx.wmsPickBatch.update({
        where: { id: batchId },
        data: { status: 'CLOSED', closedAt: new Date() },
        select: { id: true },
      });
  }

  // ── packages + QC ──

  async replacePackages(
    tx: Tx,
    shipmentId: string,
    rows: Omit<Prisma.WmsPackageCreateManyInput, 'shipmentId'>[],
  ) {
    await tx.wmsPackage.deleteMany({ where: { shipmentId } });
    if (rows.length > 0)
      await tx.wmsPackage.createMany({ data: rows.map((r) => ({ ...r, shipmentId })) });
  }

  packages(shipmentId: string) {
    return withPrismaErrors(() =>
      this.db.wmsPackage.findMany({ where: { shipmentId }, orderBy: { boxNo: 'asc' } }),
    );
  }

  qcChecks(shipmentId: string, tx?: Tx) {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsQcCheck.findMany({ where: { shipmentId }, orderBy: { attempt: 'asc' } }),
    );
  }

  async addQcCheck(tx: Tx, data: Prisma.WmsQcCheckUncheckedCreateInput) {
    await tx.wmsQcCheck.create({ data, select: { id: true } });
  }

  // ── holds ──

  openHold(orderId: string, tx?: Tx): Promise<HoldRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsHold.findFirst({ where: { orderId, releasedAt: null } }),
    );
  }

  holds(orderId: string): Promise<HoldRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsHold.findMany({ where: { orderId }, orderBy: { placedAt: 'desc' }, take: 20 }),
    );
  }

  createHold(tx: Tx, data: Prisma.WmsHoldUncheckedCreateInput): Promise<HoldRow> {
    return tx.wmsHold.create({ data });
  }

  updateHold(tx: Tx, id: string, data: Prisma.WmsHoldUncheckedUpdateInput): Promise<HoldRow> {
    return tx.wmsHold.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  dueAutoRelease(now: Date, limit: number) {
    return this.db.wmsHold.findMany({
      where: { releasedAt: null, autoReleaseAt: { lte: now } },
      select: { id: true, orderId: true },
      take: limit,
    });
  }

  dueKeepAllocation(now: Date, limit: number) {
    return this.db.wmsHold.findMany({
      where: { releasedAt: null, keepAllocationUntil: { lte: now } },
      select: { id: true, orderId: true },
      take: limit,
    });
  }

  // ── exceptions ──

  exception(id: string, tx?: Tx): Promise<ExceptionRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).wmsException.findUnique({ where: { id } }));
  }

  async lockException(tx: Tx, id: string): Promise<ExceptionRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_exceptions" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.exception(id, tx);
  }

  openByDedupe(tx: Tx, dedupeKey: string) {
    return tx.wmsException.findFirst({
      where: { dedupeKey, status: { in: ['OPEN', 'IN_REVIEW'] } },
    });
  }

  createException(tx: Tx, data: Prisma.WmsExceptionUncheckedCreateInput): Promise<ExceptionRow> {
    return tx.wmsException.create({ data });
  }

  updateException(tx: Tx, id: string, data: Prisma.WmsExceptionUncheckedUpdateInput) {
    return tx.wmsException.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  exceptionsOfOrder(orderId: string) {
    return withPrismaErrors(() =>
      this.db.wmsException.findMany({
        where: { orderId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  }

  // ── reallocations (saga) ──

  reallocation(id: string, tx?: Tx): Promise<ReallocationRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).wmsReallocation.findUnique({ where: { id } }));
  }

  async lockReallocation(tx: Tx, id: string): Promise<ReallocationRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_reallocations" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.reallocation(id, tx);
  }

  createReallocation(tx: Tx, data: Prisma.WmsReallocationUncheckedCreateInput) {
    return tx.wmsReallocation.create({ data });
  }

  async updateReallocation(
    tx: Tx | undefined,
    id: string,
    data: Prisma.WmsReallocationUncheckedUpdateInput,
  ) {
    await (tx ?? this.db).wmsReallocation.update({ where: { id }, data, select: { id: true } });
  }

  pendingReallocations(olderThan: Date, limit: number) {
    return this.db.wmsReallocation.findMany({
      where: { status: { in: ['PENDING', 'INVENTORY_DONE'] }, updatedAt: { lte: olderThan } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  }

  openReallocationOf(orderId: string, tx: Tx) {
    return tx.wmsReallocation.findFirst({
      where: { orderId, status: { in: ['PENDING', 'INVENTORY_DONE'] } },
    });
  }

  // ── daily counters ──

  async bumpDaily(
    tx: Tx,
    warehouseId: string,
    day: string,
    inc: Partial<Record<DailyField, number>> & {
      cycleMin?: number;
      pickToPackMin?: number;
      value?: string;
    },
  ): Promise<void> {
    const d = new Date(`${day}T00:00:00.000Z`);
    await tx.$executeRaw`INSERT INTO "warehouse_fulfilment_daily" ("warehouseId", "day", "updatedAt")
      VALUES (${warehouseId}::uuid, ${d}::date, now()) ON CONFLICT DO NOTHING`;
    const sets: Prisma.Sql[] = [];
    for (const [k, v] of Object.entries(inc)) {
      if (v === 0 || k === 'cycleMin' || k === 'pickToPackMin' || k === 'value') continue;
      sets.push(Prisma.sql`${Prisma.raw(`"${k}"`)} = ${Prisma.raw(`"${k}"`)} + ${v}`);
    }
    if (inc.cycleMin !== undefined)
      sets.push(Prisma.sql`"cycleMinSum" = "cycleMinSum" + ${Math.round(inc.cycleMin)}`);
    if (inc.pickToPackMin !== undefined)
      sets.push(
        Prisma.sql`"pickToPackMinSum" = "pickToPackMinSum" + ${Math.round(inc.pickToPackMin)}`,
      );
    if (inc.value !== undefined)
      sets.push(Prisma.sql`"valueFulfilled" = "valueFulfilled" + ${inc.value}::numeric`);
    if (sets.length === 0) return;
    await tx.$executeRaw`UPDATE "warehouse_fulfilment_daily" SET ${Prisma.join(sets, ', ')}, "updatedAt" = now()
      WHERE "warehouseId" = ${warehouseId}::uuid AND "day" = ${d}::date`;
  }

  // ── delivery (Phase 4b): OTP, POD, exports ──

  otp(shipmentId: string, tx?: Tx) {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsDeliveryOtp.findUnique({ where: { shipmentId } }),
    );
  }

  async lockOtp(tx: Tx, shipmentId: string) {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_delivery_otps" WHERE "shipmentId" = ${shipmentId}::uuid FOR UPDATE`;
    return this.otp(shipmentId, tx);
  }

  async saveOtp(
    tx: Tx,
    shipmentId: string,
    data: { otpHmac: string; otpEnc: string; expiresAt: Date; resend: boolean },
  ): Promise<void> {
    await tx.wmsDeliveryOtp.upsert({
      where: { shipmentId },
      create: { shipmentId, otpHmac: data.otpHmac, otpEnc: data.otpEnc, expiresAt: data.expiresAt },
      update: {
        otpHmac: data.otpHmac,
        otpEnc: data.otpEnc,
        expiresAt: data.expiresAt,
        attempts: 0,
        lockedAt: null,
        lastSentAt: new Date(),
        ...(data.resend ? { resendCount: { increment: 1 } } : {}),
      },
      select: { shipmentId: true },
    });
  }

  async updateOtp(tx: Tx, shipmentId: string, data: Prisma.WmsDeliveryOtpUncheckedUpdateInput) {
    await tx.wmsDeliveryOtp.update({ where: { shipmentId }, data, select: { shipmentId: true } });
  }

  pod(shipmentId: string, tx?: Tx) {
    return withPrismaErrors(() => (tx ?? this.db).wmsPod.findUnique({ where: { shipmentId } }));
  }

  async createPod(tx: Tx, data: Prisma.WmsPodUncheckedCreateInput) {
    await tx.wmsPod.create({ data, select: { shipmentId: true } });
  }

  async updatePod(tx: Tx, shipmentId: string, data: Prisma.WmsPodUncheckedUpdateInput) {
    await tx.wmsPod.update({ where: { shipmentId }, data, select: { shipmentId: true } });
  }

  podsOf(shipmentIds: readonly string[]) {
    if (shipmentIds.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsPod.findMany({ where: { shipmentId: { in: [...new Set(shipmentIds)] } } }),
    );
  }

  createExport(tx: Tx, data: Prisma.WmsExportUncheckedCreateInput) {
    return tx.wmsExport.create({ data });
  }

  export(id: string) {
    return withPrismaErrors(() => this.db.wmsExport.findUnique({ where: { id } }));
  }

  exports(requestedBy: string, cursor: string | undefined, limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsExport.findMany({
        where: { requestedBy, ...(cursor === undefined ? {} : { id: { lt: cursor } }) },
        select: {
          id: true,
          type: true,
          status: true,
          rowCount: true,
          error: true,
          createdAt: true,
          completedAt: true,
          filters: true,
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
      }),
    );
  }

  queuedExports(limit: number) {
    return this.db.wmsExport.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async updateExport(id: string, data: Prisma.WmsExportUncheckedUpdateInput) {
    await this.db.wmsExport.update({ where: { id }, data, select: { id: true } });
  }

  // ── shelf-life rules ──

  shelfLifeRules(): Promise<ShelfLifeRuleRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsShelfLifeRule.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] }),
    );
  }

  shelfLifeRule(id: string) {
    return withPrismaErrors(() => this.db.wmsShelfLifeRule.findUnique({ where: { id } }));
  }

  createShelfLifeRule(tx: Tx, data: Prisma.WmsShelfLifeRuleUncheckedCreateInput) {
    return tx.wmsShelfLifeRule.create({ data });
  }

  updateShelfLifeRule(tx: Tx, id: string, data: Prisma.WmsShelfLifeRuleUncheckedUpdateInput) {
    return tx.wmsShelfLifeRule.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  }

  async deleteShelfLifeRule(tx: Tx, id: string) {
    await tx.wmsShelfLifeRule.delete({ where: { id } });
  }

  /** Statuses of many shipments (used by reconcile). */
  statusesOf(ids: readonly string[]): Promise<{ id: string; status: ShipmentStatus }[]> {
    return withPrismaErrors(() =>
      this.db.wmsShipment.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, status: true },
      }),
    );
  }
}
