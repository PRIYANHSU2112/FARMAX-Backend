import { type Tx, withPrismaErrors } from '@farmx/database';
import { type Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { EntryStatus } from './gate.rules.js';

const LINE = {
  lineNo: true,
  variantId: true,
  sku: true,
  name: true,
  packLabel: true,
  expectedQty: true,
  unitWeightGrams: true,
  declaredNetKg: true,
} as const satisfies Prisma.WmsInboundLineSelect;

export const SHIPMENT_LIST = {
  id: true,
  shipmentNo: true,
  warehouseId: true,
  purpose: true,
  vendorId: true,
  vendorCode: true,
  vendorName: true,
  restockRequestId: true,
  restockRequestNo: true,
  vendorPoNo: true,
  vehicleRegNo: true,
  plannedVehicleRegNo: true,
  transportType: true,
  etaAt: true,
  bayCode: true,
  dockDoorId: true,
  totalUnits: true,
  payloadLabel: true,
  declaredNetKg: true,
  stage: true,
  activeEntryId: true,
  rebookingRequired: true,
  attemptNo: true,
  createdAt: true,
} as const satisfies Prisma.WmsInboundShipmentSelect;
export type ShipmentListRow = Prisma.WmsInboundShipmentGetPayload<{
  select: typeof SHIPMENT_LIST;
}>;

const SHIPMENT = {
  ...SHIPMENT_LIST,
  transferId: true,
  asnId: true,
  sourceLocation: true,
  plannedDriverName: true,
  plannedDriverMobile: true,
  dockBookingId: true,
  invoiceNetKg: true,
  invoiceGrossKg: true,
  palletCount: true,
  notes: true,
  cancelledAt: true,
  cancelReason: true,
  createdBy: true,
  version: true,
  updatedAt: true,
  lines: { select: LINE, orderBy: { lineNo: 'asc' } },
} as const satisfies Prisma.WmsInboundShipmentSelect;
export type ShipmentRow = Prisma.WmsInboundShipmentGetPayload<{ select: typeof SHIPMENT }>;

export type EntryRow = Prisma.WmsGateEntryGetPayload<object>;

export type WeighmentRow = Prisma.WmsWeighmentGetPayload<object>;
export type DocumentRow = Prisma.WmsGateDocumentGetPayload<object>;
export type PassRow = Prisma.WmsGatePassGetPayload<object>;
export type EventRow = Prisma.WmsGateEventGetPayload<object>;
export type ScaleRow = Prisma.WmsWeighScaleGetPayload<object>;
export type ReceiptLinkRow = Prisma.WmsGateEntryReceiptGetPayload<object>;

const ACTIVE_ENTRY = { notIn: ['EXITED', 'CANCELLED'] as ('EXITED' | 'CANCELLED')[] };

export interface ShipmentFilters {
  warehouseId: string;
  stages?: readonly string[];
  q?: string;
  bayId?: string;
  from?: Date;
  to?: Date;
}

/** Stages of a truck inside the gate: always listed whatever the date filter. */
const INSIDE = [
  'ARRIVED',
  'WEIGHED_IN',
  'APPROVED',
  'UNLOADING',
  'UNLOADED',
  'WEIGHED_OUT',
  'PASS_OUT',
  'BLOCKED',
  'HELD',
  'REJECTED',
] as const;

/** Only place that touches the gate tables (shipments, entries, weighments, documents, passes). */
export class GateRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── shipments ──

  shipment(id: string, tx?: Tx): Promise<ShipmentRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsInboundShipment.findUnique({ where: { id }, select: SHIPMENT }),
    );
  }

  shipmentByKey(key: string): Promise<{ id: string } | null> {
    return withPrismaErrors(() =>
      this.db.wmsInboundShipment.findUnique({
        where: { idempotencyKey: key },
        select: { id: true },
      }),
    );
  }

  async lockShipment(tx: Tx, id: string): Promise<ShipmentRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_inbound_shipments" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.shipment(id, tx);
  }

  createShipment(
    tx: Tx,
    data: Prisma.WmsInboundShipmentUncheckedCreateInput,
  ): Promise<ShipmentRow> {
    return withPrismaErrors(() => tx.wmsInboundShipment.create({ data, select: SHIPMENT }));
  }

  updateShipment(
    tx: Tx,
    id: string,
    data: Prisma.WmsInboundShipmentUncheckedUpdateInput,
  ): Promise<ShipmentRow> {
    return withPrismaErrors(() =>
      tx.wmsInboundShipment.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        select: SHIPMENT,
      }),
    );
  }

  async replaceLines(
    tx: Tx,
    shipmentId: string,
    lines: readonly Omit<Prisma.WmsInboundLineCreateManyInput, 'shipmentId'>[],
  ): Promise<void> {
    await tx.wmsInboundLine.deleteMany({ where: { shipmentId } });
    if (lines.length > 0)
      await tx.wmsInboundLine.createMany({ data: lines.map((l) => ({ ...l, shipmentId })) });
  }

  private shipmentWhere(f: ShipmentFilters): Prisma.WmsInboundShipmentWhereInput {
    const and: Prisma.WmsInboundShipmentWhereInput[] = [{ warehouseId: f.warehouseId }];
    if (f.stages !== undefined) and.push({ stage: { in: [...f.stages] as never[] } });
    if (f.bayId !== undefined) and.push({ dockDoorId: f.bayId });
    if (f.q !== undefined && f.q !== '') and.push({ searchText: { contains: f.q.toLowerCase() } });
    if (f.from !== undefined || f.to !== undefined)
      and.push({
        OR: [
          {
            etaAt: {
              ...(f.from === undefined ? {} : { gte: f.from }),
              ...(f.to === undefined ? {} : { lt: f.to }),
            },
          },
          { stage: { in: [...INSIDE] } },
        ],
      });
    return { AND: and };
  }

  /** Dashboard table: ETA ascending, keyset (etaAt, id). */
  listShipments(
    f: ShipmentFilters,
    after: { etaAt: Date; id: string } | null,
    limit: number,
  ): Promise<ShipmentListRow[]> {
    const where = this.shipmentWhere(f);
    return withPrismaErrors(() =>
      this.db.wmsInboundShipment.findMany({
        where:
          after === null
            ? where
            : {
                AND: [
                  where,
                  {
                    OR: [
                      { etaAt: { gt: after.etaAt } },
                      { etaAt: after.etaAt, id: { gt: after.id } },
                    ],
                  },
                ],
              },
        select: SHIPMENT_LIST,
        orderBy: [{ etaAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      }),
    );
  }

  async countByStage(f: Omit<ShipmentFilters, 'stages'>): Promise<Map<string, number>> {
    const rows = await withPrismaErrors(() =>
      this.db.wmsInboundShipment.groupBy({
        by: ['stage'],
        where: this.shipmentWhere(f),
        _count: { _all: true },
      }),
    );
    return new Map(rows.map((r) => [r.stage, r._count._all]));
  }

  /** Gate-entry dropdown: EXPECTED shipments due in [from, to), searchable. */
  arrivals(warehouseId: string, from: Date, to: Date, q: string | undefined, limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsInboundShipment.findMany({
        where: {
          warehouseId,
          stage: 'EXPECTED',
          etaAt: { gte: from, lt: to },
          ...(q === undefined || q === '' ? {} : { searchText: { contains: q.toLowerCase() } }),
        },
        select: SHIPMENT,
        orderBy: [{ etaAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    );
  }

  /** Σ expected qty per SKU of open shipments of a PO (not completed / cancelled). */
  async openShipmentQty(
    tx: Tx,
    restockRequestId: string,
    excludeShipmentId: string | null,
  ): Promise<Map<string, number>> {
    const rows = await tx.$queryRaw<{ variantId: string; qty: bigint }[]>`
      SELECT l."variantId", SUM(l."expectedQty")::bigint AS qty
      FROM "warehouse_inbound_lines" l
      JOIN "warehouse_inbound_shipments" s ON s."id" = l."shipmentId"
      WHERE s."restockRequestId" = ${restockRequestId}::uuid
        AND s."stage" NOT IN ('COMPLETED', 'CANCELLED')
        AND (${excludeShipmentId}::uuid IS NULL OR s."id" <> ${excludeShipmentId}::uuid)
      GROUP BY l."variantId"`;
    return new Map(rows.map((r) => [r.variantId, Number(r.qty)]));
  }

  /** Same, for many POs (PO dropdown, no lock). */
  async openShipmentQtyMany(restockRequestIds: readonly string[]) {
    if (restockRequestIds.length === 0) return new Map<string, Map<string, number>>();
    const rows = await this.db.$queryRaw<{ rid: string; variantId: string; qty: bigint }[]>`
      SELECT s."restockRequestId" AS rid, l."variantId", SUM(l."expectedQty")::bigint AS qty
      FROM "warehouse_inbound_lines" l
      JOIN "warehouse_inbound_shipments" s ON s."id" = l."shipmentId"
      WHERE s."restockRequestId" = ANY(${[...restockRequestIds]}::uuid[])
        AND s."stage" NOT IN ('COMPLETED', 'CANCELLED')
      GROUP BY s."restockRequestId", l."variantId"`;
    const out = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const m = out.get(r.rid) ?? new Map<string, number>();
      m.set(r.variantId, Number(r.qty));
      out.set(r.rid, m);
    }
    return out;
  }

  // ── entries ──

  entry(id: string, tx?: Tx): Promise<EntryRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).wmsGateEntry.findUnique({ where: { id } }));
  }

  async lockEntry(tx: Tx, id: string): Promise<EntryRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_gate_entries" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.entry(id, tx);
  }

  entryByKey(key: string): Promise<{ id: string } | null> {
    return withPrismaErrors(() =>
      this.db.wmsGateEntry.findUnique({ where: { idempotencyKey: key }, select: { id: true } }),
    );
  }

  activeEntryForShipment(shipmentId: string, tx?: Tx): Promise<EntryRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsGateEntry.findFirst({
        where: { shipmentId, status: ACTIVE_ENTRY },
      }),
    );
  }

  activeEntryForVehicle(warehouseId: string, vehicleRegNo: string, tx?: Tx) {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsGateEntry.findFirst({
        where: { warehouseId, vehicleRegNo, status: ACTIVE_ENTRY },
      }),
    );
  }

  entriesOfShipment(shipmentId: string): Promise<EntryRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsGateEntry.findMany({ where: { shipmentId }, orderBy: { arrivedAt: 'asc' } }),
    );
  }

  createEntry(tx: Tx, data: Prisma.WmsGateEntryUncheckedCreateInput): Promise<EntryRow> {
    return withPrismaErrors(() => tx.wmsGateEntry.create({ data }));
  }

  /**
   * State-guarded update: applies only while the entry is still in one of `from` (null = any).
   * Returns the updated row, or null when another request moved it first.
   */
  async guardedUpdate(
    tx: Tx,
    id: string,
    from: readonly EntryStatus[] | null,
    data: Prisma.WmsGateEntryUncheckedUpdateManyInput,
  ): Promise<EntryRow | null> {
    const n = await withPrismaErrors(() =>
      tx.wmsGateEntry.updateMany({
        where: { id, ...(from === null ? {} : { status: { in: [...from] } }) },
        data: { ...data, version: { increment: 1 } },
      }),
    );
    return n.count === 0 ? null : this.entry(id, tx);
  }

  /** Last tare of a vehicle (any warehouse): "Tare weight record available". */
  lastTare(vehicleRegNo: string) {
    return withPrismaErrors(() =>
      this.db.wmsGateEntry.findFirst({
        where: { vehicleRegNo, tareKg: { not: null } },
        select: { tareKg: true, tareAt: true, entryNo: true },
        orderBy: { tareAt: 'desc' },
      }),
    );
  }

  entriesNoReceipt(warehouseId: string, limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsGateEntry.findMany({
        where: { warehouseId, noReceipt: true },
        orderBy: { arrivedAt: 'desc' },
        take: limit,
      }),
    );
  }

  // ── CN links ──

  linkReceipt(tx: Tx, data: Prisma.WmsGateEntryReceiptUncheckedCreateInput) {
    return withPrismaErrors(() => tx.wmsGateEntryReceipt.create({ data }));
  }

  receiptsOf(gateEntryId: string, tx?: Tx): Promise<ReceiptLinkRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsGateEntryReceipt.findMany({
        where: { gateEntryId },
        orderBy: { attachedAt: 'asc' },
      }),
    );
  }

  // ── weighments ──

  weighment(id: string, tx?: Tx): Promise<WeighmentRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).wmsWeighment.findUnique({ where: { id } }));
  }

  async lockWeighment(tx: Tx, id: string): Promise<WeighmentRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_weighments" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.weighment(id, tx);
  }

  weighmentsOf(gateEntryId: string, tx?: Tx): Promise<WeighmentRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsWeighment.findMany({
        where: { gateEntryId },
        orderBy: { capturedAt: 'asc' },
      }),
    );
  }

  createWeighment(tx: Tx, data: Prisma.WmsWeighmentUncheckedCreateInput): Promise<WeighmentRow> {
    return withPrismaErrors(() => tx.wmsWeighment.create({ data }));
  }

  async updateWeighmentIf(
    tx: Tx,
    id: string,
    status: string,
    data: Prisma.WmsWeighmentUncheckedUpdateManyInput,
  ): Promise<boolean> {
    const n = await withPrismaErrors(() =>
      tx.wmsWeighment.updateMany({
        where: { id, status: status as never },
        data,
      }),
    );
    return n.count === 1;
  }

  async hasPendingWeighment(tx: Tx, gateEntryId: string): Promise<boolean> {
    return (
      (await tx.wmsWeighment.count({ where: { gateEntryId, status: 'PENDING_APPROVAL' } })) > 0
    );
  }

  pendingWeighments(warehouseId: string, limit: number): Promise<WeighmentRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsWeighment.findMany({
        where: { warehouseId, status: 'PENDING_APPROVAL' },
        orderBy: { capturedAt: 'desc' },
        take: limit,
      }),
    );
  }

  heldEntries(warehouseId: string, limit: number): Promise<EntryRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsGateEntry.findMany({
        where: { warehouseId, status: 'HELD' },
        orderBy: { heldAt: 'desc' },
        take: limit,
      }),
    );
  }

  entriesByIds(ids: readonly string[]): Promise<EntryRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsGateEntry.findMany({ where: { id: { in: [...new Set(ids)] } } }),
    );
  }

  // ── documents ──

  document(id: string, tx?: Tx): Promise<DocumentRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).wmsGateDocument.findUnique({ where: { id } }));
  }

  async lockDocument(tx: Tx, id: string): Promise<DocumentRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_gate_documents" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.document(id, tx);
  }

  documentsOf(shipmentId: string, tx?: Tx): Promise<DocumentRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsGateDocument.findMany({
        where: { shipmentId },
        orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  createDocument(tx: Tx, data: Prisma.WmsGateDocumentUncheckedCreateInput): Promise<DocumentRow> {
    return withPrismaErrors(() => tx.wmsGateDocument.create({ data }));
  }

  updateDocument(
    tx: Tx,
    id: string,
    data: Prisma.WmsGateDocumentUncheckedUpdateInput,
  ): Promise<DocumentRow> {
    return withPrismaErrors(() =>
      tx.wmsGateDocument.update({ where: { id }, data: { ...data, version: { increment: 1 } } }),
    );
  }

  async deleteDocument(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsGateDocument.delete({ where: { id } }));
  }

  /** PII scans (DL / RC) of trucks that exited before `before`, still holding media. */
  piiDocumentsDue(before: Date, limit: number) {
    return withPrismaErrors(
      () =>
        this.db.$queryRaw<{ id: string; mediaKey: string }[]>`
        SELECT d."id", d."mediaKey"
        FROM "warehouse_gate_documents" d
        JOIN "warehouse_inbound_shipments" s ON s."id" = d."shipmentId"
        WHERE d."docType" IN ('DRIVER_LICENCE', 'RC_BOOK')
          AND d."mediaKey" IS NOT NULL
          AND d."mediaPurgedAt" IS NULL
          AND s."stage" IN ('COMPLETED', 'CANCELLED', 'EXPECTED')
          AND d."uploadedAt" < ${before}
        LIMIT ${limit}`,
    );
  }

  // ── passes ──

  pass(id: string, tx?: Tx): Promise<PassRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).wmsGatePass.findUnique({ where: { id } }));
  }

  passByNo(passNo: string): Promise<PassRow | null> {
    return withPrismaErrors(() => this.db.wmsGatePass.findUnique({ where: { passNo } }));
  }

  passesOf(gateEntryId: string): Promise<PassRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsGatePass.findMany({ where: { gateEntryId }, orderBy: { issuedAt: 'asc' } }),
    );
  }

  livePass(tx: Tx, gateEntryId: string, type: 'INWARD' | 'OUTWARD'): Promise<PassRow | null> {
    return withPrismaErrors(() =>
      tx.wmsGatePass.findFirst({ where: { gateEntryId, type, status: { not: 'VOID' } } }),
    );
  }

  createPass(tx: Tx, data: Prisma.WmsGatePassUncheckedCreateInput): Promise<PassRow> {
    return withPrismaErrors(() => tx.wmsGatePass.create({ data }));
  }

  /** ISSUED → USED atomically (single-use scan); false when it was not ISSUED any more. */
  async usePass(tx: Tx, id: string, userId: string): Promise<boolean> {
    const n = await tx.wmsGatePass.updateMany({
      where: { id, status: 'ISSUED' },
      data: { status: 'USED', usedAt: new Date(), usedBy: userId },
    });
    return n.count === 1;
  }

  /** ISSUED (or any live) → VOID; false when already VOID / USED as required. */
  async voidPass(
    tx: Tx,
    id: string,
    from: readonly ('ISSUED' | 'USED')[],
    reason: string,
    replacedById: string | null = null,
  ): Promise<boolean> {
    const n = await tx.wmsGatePass.updateMany({
      where: { id, status: { in: [...from] } },
      data: {
        status: 'VOID',
        voidedAt: new Date(),
        voidReason: reason.slice(0, 300),
        replacedById,
      },
    });
    return n.count === 1;
  }

  setReplacement(tx: Tx, id: string, replacedById: string) {
    return tx.wmsGatePass.update({ where: { id }, data: { replacedById } });
  }

  // ── timeline ──

  addEvent(tx: Tx, data: Prisma.WmsGateEventUncheckedCreateInput): Promise<EventRow> {
    return withPrismaErrors(() => tx.wmsGateEvent.create({ data }));
  }

  eventsOf(shipmentId: string): Promise<EventRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsGateEvent.findMany({
        where: { shipmentId },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
        take: 500,
      }),
    );
  }

  recentEvents(
    warehouseId: string,
    types: readonly string[],
    after: { at: Date; id: string } | null,
    limit: number,
  ): Promise<EventRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsGateEvent.findMany({
        where: {
          warehouseId,
          type: { in: [...types] },
          ...(after === null
            ? {}
            : { OR: [{ at: { lt: after.at } }, { at: after.at, id: { lt: after.id } }] }),
        },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    );
  }

  // ── scales ──

  scales(warehouseId: string, tx?: Tx): Promise<ScaleRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsWeighScale.findMany({ where: { warehouseId }, orderBy: { code: 'asc' } }),
    );
  }

  scale(id: string, tx?: Tx): Promise<ScaleRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).wmsWeighScale.findUnique({ where: { id } }));
  }

  createScale(tx: Tx, data: Prisma.WmsWeighScaleUncheckedCreateInput): Promise<ScaleRow> {
    return withPrismaErrors(() => tx.wmsWeighScale.create({ data }));
  }

  async updateScaleVersioned(
    tx: Tx,
    id: string,
    expectedVersion: number,
    data: Prisma.WmsWeighScaleUncheckedUpdateManyInput,
  ): Promise<ScaleRow | null> {
    const n = await withPrismaErrors(() =>
      tx.wmsWeighScale.updateMany({
        where: { id, version: expectedVersion },
        data: { ...data, version: { increment: 1 } },
      }),
    );
    return n.count === 0 ? null : this.scale(id, tx);
  }

  async deleteScale(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsWeighScale.delete({ where: { id } }));
  }

  async scaleUsed(tx: Tx, scaleId: string): Promise<boolean> {
    return (await tx.wmsWeighment.count({ where: { scaleId } })) > 0;
  }

  touchScale(tx: Tx, id: string, at: Date) {
    return tx.wmsWeighScale.update({ where: { id }, data: { lastWeighedAt: at } });
  }

  // ── header search ──

  /** Shipments (INB / vehicle / vendor / PO), entries (GE / vehicle) and passes (GPI / GPO). */
  async search(scope: 'ALL' | readonly string[], q: string, limit: number) {
    const wh = scope === 'ALL' ? {} : { warehouseId: { in: [...scope] } };
    const reg = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const [shipments, entries, passes] = await Promise.all([
      this.db.wmsInboundShipment.findMany({
        where: { ...wh, searchText: { contains: q.toLowerCase() } },
        select: {
          id: true,
          shipmentNo: true,
          vendorName: true,
          stage: true,
          warehouseId: true,
          vehicleRegNo: true,
        },
        orderBy: { etaAt: 'desc' },
        take: limit,
      }),
      reg.length < 3
        ? Promise.resolve([])
        : this.db.wmsGateEntry.findMany({
            where: {
              ...wh,
              OR: [{ entryNo: { contains: q.toUpperCase() } }, { vehicleRegNo: { contains: reg } }],
            },
            select: {
              id: true,
              entryNo: true,
              vehicleRegNo: true,
              status: true,
              warehouseId: true,
            },
            orderBy: { arrivedAt: 'desc' },
            take: limit,
          }),
      /^GP[IO]/i.test(q)
        ? this.db.wmsGatePass.findMany({
            where: { ...wh, passNo: { startsWith: q.toUpperCase() } },
            select: { id: true, passNo: true, status: true, warehouseId: true, gateEntryId: true },
            take: limit,
          })
        : Promise.resolve([]),
    ]);
    return { shipments, entries, passes };
  }

  // ── dashboard aggregates (one SQL each) ──

  /**
   * W5.01 KPI cards in ONE scan of today's / yesterday's / still-inside entries
   * (indexes (warehouseId, arrivedAt) and (warehouseId, status), BitmapOr).
   */
  async daySummary(
    warehouseId: string,
    today: { from: Date; to: Date },
    yesterday: { from: Date; to: Date },
    now: Date,
  ) {
    const [r] = await this.db.$queryRaw<
      {
        weighedToday: bigint;
        weighedYesterday: bigint;
        completedToday: bigint;
        active: bigint;
        held: bigint;
        blocked: bigint;
        rejectedInside: bigint;
        rejectedToday: bigint;
        entriesToday: bigint;
        exitsToday: bigint;
        inside: bigint;
        avgWaitMin: number | null;
      }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE "grossAt" >= ${today.from} AND "grossAt" < ${today.to}) AS "weighedToday",
        COUNT(*) FILTER (WHERE "grossAt" >= ${yesterday.from} AND "grossAt" < ${yesterday.to}) AS "weighedYesterday",
        COUNT(*) FILTER (WHERE "grossAt" >= ${today.from} AND "grossAt" < ${today.to}
                           AND "status" = 'EXITED' AND "outcome" = 'COMPLETED') AS "completedToday",
        COUNT(*) FILTER (WHERE "status" IN ('WEIGHED_IN','APPROVED','UNLOADING','UNLOADED','WEIGHED_OUT','PASS_OUT')) AS "active",
        COUNT(*) FILTER (WHERE "status" = 'HELD') AS "held",
        COUNT(*) FILTER (WHERE "status" = 'BLOCKED') AS "blocked",
        COUNT(*) FILTER (WHERE "status" = 'REJECTED') AS "rejectedInside",
        COUNT(*) FILTER (WHERE "outcome" = 'REJECTED' AND "exitedAt" >= ${today.from} AND "exitedAt" < ${today.to}) AS "rejectedToday",
        COUNT(*) FILTER (WHERE "arrivedAt" >= ${today.from} AND "arrivedAt" < ${today.to}) AS "entriesToday",
        COUNT(*) FILTER (WHERE "exitedAt" >= ${today.from} AND "exitedAt" < ${today.to}) AS "exitsToday",
        COUNT(*) FILTER (WHERE "status" NOT IN ('EXITED','CANCELLED')) AS "inside",
        (AVG(EXTRACT(EPOCH FROM (COALESCE("grossAt", ${now}) - "arrivedAt")) / 60.0)
          FILTER (WHERE "arrivedAt" >= ${today.from} AND "arrivedAt" < ${today.to}
                    AND "status" <> 'CANCELLED'))::float8 AS "avgWaitMin"
      FROM "warehouse_gate_entries"
      WHERE "warehouseId" = ${warehouseId}::uuid
        AND ("arrivedAt" >= ${yesterday.from} OR "status" NOT IN ('EXITED','CANCELLED'))`;
    const n = (v: bigint | undefined) => Number(v ?? 0n);
    return {
      weighedToday: n(r?.weighedToday),
      weighedYesterday: n(r?.weighedYesterday),
      completedToday: n(r?.completedToday),
      active: n(r?.active),
      held: n(r?.held),
      blocked: n(r?.blocked),
      rejectedInside: n(r?.rejectedInside),
      rejectedToday: n(r?.rejectedToday),
      entriesToday: n(r?.entriesToday),
      exitsToday: n(r?.exitsToday),
      inside: n(r?.inside),
      avgWaitMin: r?.avgWaitMin ?? null,
    };
  }

  /** Shipments due today (not cancelled). */
  scheduledBetween(warehouseId: string, from: Date, to: Date): Promise<number> {
    return withPrismaErrors(() =>
      this.db.wmsInboundShipment.count({
        where: { warehouseId, etaAt: { gte: from, lt: to }, stage: { not: 'CANCELLED' } },
      }),
    );
  }

  /** Delayed: still EXPECTED past ETA + grace. */
  delayedCount(warehouseId: string, cutoff: Date, from: Date): Promise<number> {
    return withPrismaErrors(() =>
      this.db.wmsInboundShipment.count({
        where: { warehouseId, stage: 'EXPECTED', etaAt: { gte: from, lt: cutoff } },
      }),
    );
  }

  // ── retention (drivers) ──

  /** Exited entries past the driver retention, still holding PII. */
  driversDue(
    before: Date,
    limit: number,
  ): Promise<{ id: string; driverName: string; driverMobile: string }[]> {
    return withPrismaErrors(() =>
      this.db.wmsGateEntry.findMany({
        where: {
          piiRedactedAt: null,
          OR: [{ exitedAt: { lt: before } }, { cancelledAt: { lt: before } }],
        },
        select: { id: true, driverName: true, driverMobile: true },
        take: limit,
      }),
    );
  }

  async redactDriver(
    tx: Tx,
    id: string,
    data: { driverName: string; driverMobile: string },
  ): Promise<void> {
    await tx.wmsGateEntry.update({
      where: { id },
      data: { ...data, driverLicenceNo: null, piiRedactedAt: new Date() },
    });
  }
}
