import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { WarehouseScope } from '../../middleware/access.js';

const SH_IN_SCOPE = (scope: WarehouseScope, alias = 's'): Prisma.Sql =>
  scope === 'ALL'
    ? Prisma.empty
    : Prisma.sql`AND ${Prisma.raw(`${alias}."warehouseId"`)} = ANY(${[...scope]}::uuid[])`;
const inScope = (col: string, scope: WarehouseScope, warehouseId?: string): Prisma.Sql => {
  if (warehouseId !== undefined) return Prisma.sql`AND ${Prisma.raw(col)} = ${warehouseId}::uuid`;
  return scope === 'ALL'
    ? Prisma.empty
    : Prisma.sql`AND ${Prisma.raw(col)} = ANY(${[...scope]}::uuid[])`;
};
const pageSql = (page: { limit: number; offset: number | null }) =>
  Prisma.sql`LIMIT ${page.limit + 1} ${page.offset === null ? Prisma.empty : Prisma.sql`OFFSET ${page.offset}`}`;

export interface OrderFilter {
  tab?: string;
  q?: string;
  payment?: string;
  warehouseId?: string;
  pin?: string;
  from?: string;
  to?: string;
}

export interface OrderListRow {
  orderId: string;
  orderNo: string;
  placedAt: Date;
  customerName: string | null;
  farmName: string | null;
  segment: string | null;
  pinCode: string | null;
  district: string | null;
  itemCount: number;
  unitCount: number;
  grandTotal: Prisma.Decimal;
  paymentStatus: string;
  orderStatus: string;
  complianceStatus: string;
  holdActive: boolean;
  warehouseIds: string[];
  shipmentStatuses: string[];
  firstVariantId: string | null;
  firstName: string | null;
  needsAllocation: boolean;
}

export interface ProcessingFilter {
  stage?: string;
  q?: string;
  date?: string;
  warehouseId?: string;
  customerId?: string;
  priority?: string;
  operatorId?: string;
  stagingAreaId?: string;
}

/** Read-side SQL of the fulfilment screens (lists, KPIs, dashboard). Index-backed, paged. */
export class FulfilmentReadRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── W3.02 orders ──

  private orderWhere(scope: WarehouseScope, f: OrderFilter): Prisma.Sql {
    const visible =
      scope === 'ALL'
        ? Prisma.empty
        : Prisma.sql`AND EXISTS (SELECT 1 FROM "warehouse_shipments" s WHERE s."orderId" = o."orderId" ${SH_IN_SCOPE(scope)})`;
    const at = (statuses: string[]) =>
      Prisma.sql`EXISTS (SELECT 1 FROM "warehouse_shipments" s WHERE s."orderId" = o."orderId" AND s."status"::text = ANY(${statuses}) ${SH_IN_SCOPE(scope)})`;
    const needs = Prisma.sql`(EXISTS (SELECT 1 FROM "warehouse_exceptions" e WHERE e."orderId" = o."orderId"
        AND e."status" IN ('OPEN','IN_REVIEW') AND e."type" IN ('ALLOCATION_ISSUE','SHORTAGE'))
      OR (o."paymentStatus" = 'PAID' AND o."orderStatus" IN ('PENDING_ADMIN_CONFIRMATION','CONFIRMED')
        AND NOT EXISTS (SELECT 1 FROM "warehouse_shipments" s2 WHERE s2."orderId" = o."orderId" AND s2."status" <> 'CANCELLED')))`;
    const tab =
      f.tab === 'new'
        ? Prisma.sql`AND ${at(['PENDING_RELEASE', 'RELEASED'])}`
        : f.tab === 'paid'
          ? Prisma.sql`AND o."paymentStatus" IN ('PAID','PARTIALLY_REFUNDED') AND ${at(['PENDING_RELEASE', 'RELEASED'])}`
          : f.tab === 'pending'
            ? Prisma.sql`AND o."paymentStatus" IN ('PENDING','FAILED')`
            : f.tab === 'unassigned'
              ? Prisma.sql`AND ${needs}`
              : Prisma.empty;
    return Prisma.sql`WHERE true ${visible} ${tab}
      ${f.warehouseId === undefined ? Prisma.empty : Prisma.sql`AND EXISTS (SELECT 1 FROM "warehouse_shipments" s3 WHERE s3."orderId" = o."orderId" AND s3."warehouseId" = ${f.warehouseId}::uuid AND s3."status" <> 'CANCELLED')`}
      ${f.q === undefined ? Prisma.empty : Prisma.sql`AND o."searchText" ILIKE ${`%${f.q.toLowerCase()}%`}`}
      ${f.payment === 'paid' ? Prisma.sql`AND o."paymentStatus" IN ('PAID','PARTIALLY_REFUNDED')` : Prisma.empty}
      ${f.payment === 'pending' ? Prisma.sql`AND o."paymentStatus" IN ('PENDING','FAILED')` : Prisma.empty}
      ${f.payment === 'refunded' ? Prisma.sql`AND o."paymentStatus" IN ('REFUNDED','PARTIALLY_REFUNDED')` : Prisma.empty}
      ${f.pin === undefined ? Prisma.empty : Prisma.sql`AND o."pinCode" = ${f.pin}`}
      ${f.from === undefined ? Prisma.empty : Prisma.sql`AND o."placedAt" >= ${new Date(`${f.from}T00:00:00+05:30`)}`}
      ${f.to === undefined ? Prisma.empty : Prisma.sql`AND o."placedAt" < ${new Date(new Date(`${f.to}T00:00:00+05:30`).getTime() + 86_400_000)}`}`;
  }

  orders(
    scope: WarehouseScope,
    f: OrderFilter,
    page: { limit: number; offset: number | null; after: unknown[] | null },
  ) {
    const after =
      page.after === null || page.offset !== null
        ? Prisma.empty
        : Prisma.sql`AND (o."placedAt", o."orderId") < (${new Date(page.after[0] as string)}, ${page.after[1]}::uuid)`;
    return this.db.$queryRaw<OrderListRow[]>`
      SELECT o."orderId", o."orderNo", o."placedAt", o."customerName", o."farmName", o."segment", o."pinCode",
        o."district", o."itemCount", o."unitCount", o."grandTotal", o."paymentStatus", o."orderStatus",
        o."complianceStatus"::text AS "complianceStatus", o."holdActive",
        COALESCE(sh.whs, '{}') AS "warehouseIds", COALESCE(sh.sts, '{}') AS "shipmentStatuses",
        fl."variantId" AS "firstVariantId", fl."name" AS "firstName",
        EXISTS (SELECT 1 FROM "warehouse_exceptions" e WHERE e."orderId" = o."orderId"
          AND e."status" IN ('OPEN','IN_REVIEW') AND e."type" IN ('ALLOCATION_ISSUE','SHORTAGE')) AS "needsAllocation"
      FROM "warehouse_orders" o
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT s."warehouseId"::text) AS whs, array_agg(s."status"::text ORDER BY s."createdAt") AS sts
        FROM "warehouse_shipments" s WHERE s."orderId" = o."orderId" AND s."status" <> 'CANCELLED'
      ) sh ON true
      LEFT JOIN LATERAL (
        SELECT l."variantId"::text AS "variantId", l."name" FROM "warehouse_order_lines" l
        WHERE l."orderId" = o."orderId" ORDER BY l."lineNo" LIMIT 1
      ) fl ON true
      ${this.orderWhere(scope, f)} ${after}
      ORDER BY o."placedAt" DESC, o."orderId" DESC
      ${pageSql(page)}`;
  }

  async ordersCount(scope: WarehouseScope, f: OrderFilter): Promise<number> {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM "warehouse_orders" o ${this.orderWhere(scope, f)} LIMIT 10001) x`;
    return r?.n ?? 0;
  }

  async orderKpis(scope: WarehouseScope, warehouseId?: string) {
    const visible =
      warehouseId !== undefined
        ? Prisma.sql`AND EXISTS (SELECT 1 FROM "warehouse_shipments" s WHERE s."orderId" = o."orderId" AND s."warehouseId" = ${warehouseId}::uuid)`
        : scope === 'ALL'
          ? Prisma.empty
          : Prisma.sql`AND EXISTS (SELECT 1 FROM "warehouse_shipments" s WHERE s."orderId" = o."orderId" ${SH_IN_SCOPE(scope)})`;
    const sc =
      warehouseId === undefined
        ? SH_IN_SCOPE(scope, 'x')
        : Prisma.sql`AND x."warehouseId" = ${warehouseId}::uuid`;
    const [r] = await this.db.$queryRaw<
      {
        all: number;
        new: number;
        paid: number;
        pending: number;
        unassigned: number;
        active: number;
      }[]
    >`
      SELECT count(*)::int AS "all",
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "warehouse_shipments" x WHERE x."orderId" = o."orderId" AND x."status" IN ('PENDING_RELEASE','RELEASED') ${sc}))::int AS "new",
        count(*) FILTER (WHERE o."paymentStatus" IN ('PAID','PARTIALLY_REFUNDED') AND EXISTS (SELECT 1 FROM "warehouse_shipments" x WHERE x."orderId" = o."orderId" AND x."status" IN ('PENDING_RELEASE','RELEASED') ${sc}))::int AS paid,
        count(*) FILTER (WHERE o."paymentStatus" IN ('PENDING','FAILED'))::int AS pending,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "warehouse_exceptions" e WHERE e."orderId" = o."orderId" AND e."status" IN ('OPEN','IN_REVIEW') AND e."type" IN ('ALLOCATION_ISSUE','SHORTAGE')))::int AS unassigned,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "warehouse_shipments" x WHERE x."orderId" = o."orderId" AND x."status" IN ('RELEASED','ALLOCATED','ASSIGNED','PICKING','PACKING','QC','READY_TO_DISPATCH') ${sc}))::int AS active
      FROM "warehouse_orders" o WHERE true ${visible}`;
    return r ?? { all: 0, new: 0, paid: 0, pending: 0, unassigned: 0, active: 0 };
  }

  orderFilterOptions(scope: WarehouseScope, field: 'pin' | 'customer', q: string | undefined) {
    const visible =
      scope === 'ALL'
        ? Prisma.empty
        : Prisma.sql`AND EXISTS (SELECT 1 FROM "warehouse_shipments" s WHERE s."orderId" = o."orderId" ${SH_IN_SCOPE(scope)})`;
    if (field === 'pin')
      return this.db.$queryRaw<{ value: string; label: string; count: number }[]>`
        SELECT o."pinCode" AS value, o."pinCode" || COALESCE(' · ' || max(o."district"), '') AS label, count(*)::int AS count
        FROM "warehouse_orders" o WHERE o."pinCode" IS NOT NULL ${visible}
        ${q === undefined ? Prisma.empty : Prisma.sql`AND o."pinCode" LIKE ${`${q}%`}`}
        GROUP BY o."pinCode" ORDER BY count(*) DESC LIMIT 50`;
    return this.db.$queryRaw<{ value: string; label: string; count: number }[]>`
      SELECT o."userId"::text AS value, max(COALESCE(o."farmName", o."customerName", '')) AS label, count(*)::int AS count
      FROM "warehouse_orders" o WHERE o."userId" IS NOT NULL ${visible}
      ${q === undefined ? Prisma.empty : Prisma.sql`AND (o."customerName" ILIKE ${`%${q}%`} OR o."farmName" ILIKE ${`%${q}%`})`}
      GROUP BY o."userId" ORDER BY count(*) DESC LIMIT 50`;
  }

  /** Sidebar badges (W3.15). */
  async navCounts(scope: WarehouseScope, warehouseId?: string) {
    const [r] = await this.db.$queryRaw<
      { newOrders: number; openExceptions: number; compliancePending: number; onHold: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM "warehouse_shipments" s WHERE s."status" IN ('PENDING_RELEASE','RELEASED') ${inScope('s."warehouseId"', scope, warehouseId)}) AS "newOrders",
        (SELECT count(*)::int FROM "warehouse_exceptions" e WHERE e."status" IN ('OPEN','IN_REVIEW') ${inScope('e."warehouseId"', scope, warehouseId)}) AS "openExceptions",
        (SELECT count(*)::int FROM "warehouse_compliance_cases" c WHERE c."status" IN ('PENDING','FLAGGED') ${inScope('c."warehouseId"', scope, warehouseId)}) AS "compliancePending",
        (SELECT count(*)::int FROM "warehouse_shipments" s WHERE s."holdActive" AND s."status" IN ('RELEASED','ALLOCATED','ASSIGNED','PICKING','PACKING','QC','READY_TO_DISPATCH') ${inScope('s."warehouseId"', scope, warehouseId)}) AS "onHold"`;
    return r ?? { newOrders: 0, openExceptions: 0, compliancePending: 0, onHold: 0 };
  }

  // ── W3.07 processing ──

  private processingWhere(scope: WarehouseScope, f: ProcessingFilter, statuses: readonly string[]) {
    return Prisma.sql`WHERE s."status"::text = ANY(${[...statuses]}) ${inScope('s."warehouseId"', scope, f.warehouseId)}
      ${f.q === undefined ? Prisma.empty : Prisma.sql`AND (o."searchText" ILIKE ${`%${f.q.toLowerCase()}%`} OR s."shipmentNo" ILIKE ${`%${f.q}%`})`}
      ${f.date === undefined ? Prisma.empty : Prisma.sql`AND s."releasedAt" >= ${new Date(`${f.date}T00:00:00+05:30`)} AND s."releasedAt" < ${new Date(new Date(`${f.date}T00:00:00+05:30`).getTime() + 86_400_000)}`}
      ${f.customerId === undefined ? Prisma.empty : Prisma.sql`AND o."userId" = ${f.customerId}::uuid`}
      ${f.priority === undefined ? Prisma.empty : Prisma.sql`AND s."priority"::text = ${f.priority}`}
      ${f.stagingAreaId === undefined ? Prisma.empty : Prisma.sql`AND s."stagingAreaId" = ${f.stagingAreaId}::uuid`}
      ${f.operatorId === undefined ? Prisma.empty : Prisma.sql`AND t."assigneeUserId" = ${f.operatorId}::uuid`}`;
  }

  processing(
    scope: WarehouseScope,
    f: ProcessingFilter,
    statuses: readonly string[],
    page: { limit: number; offset: number | null; after: unknown[] | null },
  ) {
    const after =
      page.after === null || page.offset !== null
        ? Prisma.empty
        : Prisma.sql`AND (COALESCE(s."slaDueAt", 'infinity'::timestamp), s."id") > (${page.after[0] === null ? new Date('9999-12-31') : new Date(page.after[0] as string)}, ${page.after[1]}::uuid)`;
    return this.db.$queryRaw<
      {
        id: string;
        shipmentNo: string;
        orderId: string;
        orderNo: string;
        warehouseId: string;
        status: string;
        priority: string;
        holdActive: boolean;
        atRisk: boolean;
        slaDueAt: Date | null;
        releasedAt: Date | null;
        lineCount: number;
        unitCount: number;
        weightKg: Prisma.Decimal;
        stagingAreaId: string | null;
        customerName: string | null;
        farmName: string | null;
        segment: string | null;
        taskId: string | null;
        assigneeUserId: string | null;
        pickBatchId: string | null;
        allocated: number;
        picked: number;
        packed: number;
        ordered: number;
      }[]
    >`
      SELECT s."id", s."shipmentNo", s."orderId", o."orderNo", s."warehouseId", s."status"::text AS status,
        s."priority"::text AS priority, s."holdActive", s."atRisk", s."slaDueAt", s."releasedAt", s."lineCount",
        s."unitCount", s."weightKg", s."stagingAreaId", o."customerName", o."farmName", o."segment",
        t."id" AS "taskId", t."assigneeUserId", t."pickBatchId",
        COALESCE(ln.allocated, 0)::int AS allocated, COALESCE(ln.picked, 0)::int AS picked,
        COALESCE(ln.packed, 0)::int AS packed, COALESCE(ln.ordered, 0)::int AS ordered
      FROM "warehouse_shipments" s
      JOIN "warehouse_orders" o ON o."orderId" = s."orderId"
      LEFT JOIN LATERAL (
        SELECT t."id", t."assigneeUserId", t."pickBatchId" FROM "warehouse_tasks" t
        WHERE t."shipmentId" = s."id" AND t."status" <> 'CANCELLED' ORDER BY t."createdAt" DESC LIMIT 1
      ) t ON true
      LEFT JOIN LATERAL (
        SELECT sum(l."allocatedQty") AS allocated, sum(l."pickedQty") AS picked, sum(l."packedQty") AS packed,
          sum(l."qty" - l."cancelledQty") AS ordered
        FROM "warehouse_shipment_lines" l WHERE l."shipmentId" = s."id"
      ) ln ON true
      ${this.processingWhere(scope, f, statuses)} ${after}
      ORDER BY COALESCE(s."slaDueAt", 'infinity'::timestamp), s."id"
      ${pageSql(page)}`;
  }

  async processingCount(scope: WarehouseScope, f: ProcessingFilter, statuses: readonly string[]) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM "warehouse_shipments" s JOIN "warehouse_orders" o ON o."orderId" = s."orderId"
        LEFT JOIN LATERAL (SELECT t."assigneeUserId" FROM "warehouse_tasks" t WHERE t."shipmentId" = s."id" AND t."status" <> 'CANCELLED' ORDER BY t."createdAt" DESC LIMIT 1) t ON true
        ${this.processingWhere(scope, f, statuses)} LIMIT 10001) x`;
    return r?.n ?? 0;
  }

  /** Current shipments per status (strip, tabs, donut). */
  statusCounts(scope: WarehouseScope, warehouseId?: string, createdFrom?: Date, createdTo?: Date) {
    return this.db.$queryRaw<{ status: string; n: number; held: number }[]>`
      SELECT s."status"::text AS status, count(*)::int AS n, count(*) FILTER (WHERE s."holdActive")::int AS held
      FROM "warehouse_shipments" s
      WHERE true ${inScope('s."warehouseId"', scope, warehouseId)}
        ${createdFrom === undefined ? Prisma.empty : Prisma.sql`AND s."createdAt" >= ${createdFrom}`}
        ${createdTo === undefined ? Prisma.empty : Prisma.sql`AND s."createdAt" < ${createdTo}`}
      GROUP BY 1`;
  }

  async activePickTasks(scope: WarehouseScope, warehouseId?: string): Promise<number> {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "warehouse_tasks" t WHERE t."status" = 'IN_PROGRESS' ${inScope('t."warehouseId"', scope, warehouseId)}`;
    return r?.n ?? 0;
  }

  /** Daily counters of a range (IST days inclusive). */
  daily(scope: WarehouseScope, warehouseId: string | undefined, from: string, to: string) {
    return this.db.$queryRaw<
      {
        day: Date;
        received: number;
        released: number;
        dispatched: number;
        onTimeDispatch: number;
        delivered: number;
        onTimeDelivery: number;
        fulfilled: number;
        cancelled: number;
        cycleMinSum: number;
        pickToPackMinSum: number;
        pickToPackCount: number;
        qcFirst: number;
        qcTotal: number;
        exceptionsOpened: number;
        valueFulfilled: string;
      }[]
    >`
      SELECT d."day", sum(d."received")::int AS received, sum(d."released")::int AS released,
        sum(d."dispatched")::int AS dispatched, sum(d."onTimeDispatch")::int AS "onTimeDispatch",
        sum(d."delivered")::int AS delivered, sum(d."onTimeDelivery")::int AS "onTimeDelivery",
        sum(d."fulfilled")::int AS fulfilled, sum(d."cancelled")::int AS cancelled,
        sum(d."cycleMinSum")::float8 AS "cycleMinSum", sum(d."pickToPackMinSum")::float8 AS "pickToPackMinSum",
        sum(d."pickToPackCount")::int AS "pickToPackCount", sum(d."qcFirst")::int AS "qcFirst",
        sum(d."qcTotal")::int AS "qcTotal", sum(d."exceptionsOpened")::int AS "exceptionsOpened",
        sum(d."valueFulfilled")::text AS "valueFulfilled"
      FROM "warehouse_fulfilment_daily" d
      WHERE d."day" BETWEEN ${from}::date AND ${to}::date ${inScope('d."warehouseId"', scope, warehouseId)}
      GROUP BY d."day" ORDER BY d."day"`;
  }

  /** Fulfilment rate inputs for shipments due in a range (§3.3). */
  async fulfilmentRate(
    scope: WarehouseScope,
    warehouseId: string | undefined,
    from: Date,
    to: Date,
    windowH: number,
    graceH: number,
  ) {
    const [r] = await this.db.$queryRaw<
      {
        due: number;
        onTime: number;
        withinWindow: number;
        bufferDelay: number;
        critical: number;
        late: number;
      }[]
    >`
      SELECT count(*)::int AS due,
        count(*) FILTER (WHERE s."dispatchedAt" IS NOT NULL AND s."dispatchedAt" <= s."slaDueAt")::int AS "onTime",
        count(*) FILTER (WHERE s."dispatchedAt" IS NOT NULL AND s."releasedAt" IS NOT NULL
          AND s."dispatchedAt" <= s."releasedAt" + make_interval(hours => ${windowH}))::int AS "withinWindow",
        count(*) FILTER (WHERE s."dispatchedAt" IS NOT NULL AND s."dispatchedAt" > s."slaDueAt"
          AND s."dispatchedAt" <= s."slaDueAt" + make_interval(hours => ${graceH}))::int AS "bufferDelay",
        count(*) FILTER (WHERE s."dispatchedAt" IS NULL AND (s."holdActive" OR EXISTS (
          SELECT 1 FROM "warehouse_exceptions" e WHERE e."shipmentId" = s."id" AND e."severity" = 'CRITICAL' AND e."status" IN ('OPEN','IN_REVIEW'))))::int AS critical,
        count(*) FILTER (WHERE (s."dispatchedAt" IS NULL AND s."slaDueAt" < now()) OR s."dispatchedAt" > s."slaDueAt" + make_interval(hours => ${graceH}))::int AS late
      FROM "warehouse_shipments" s
      WHERE s."slaDueAt" >= ${from} AND s."slaDueAt" < ${to} AND s."status" <> 'CANCELLED'
        ${inScope('s."warehouseId"', scope, warehouseId)}`;
    return r ?? { due: 0, onTime: 0, withinWindow: 0, bufferDelay: 0, critical: 0, late: 0 };
  }

  recentShipments(scope: WarehouseScope, warehouseId: string | undefined, limit: number) {
    return this.db.$queryRaw<
      {
        id: string;
        shipmentNo: string;
        orderId: string;
        orderNo: string;
        warehouseId: string;
        status: string;
        slaDueAt: Date | null;
        releasedAt: Date | null;
        customerName: string | null;
        farmName: string | null;
        lineCount: number;
        weightKg: Prisma.Decimal;
        routeId: string | null;
        topVariantId: string | null;
      }[]
    >`
      SELECT s."id", s."shipmentNo", s."orderId", o."orderNo", s."warehouseId", s."status"::text AS status, s."slaDueAt",
        s."releasedAt", o."customerName", o."farmName", s."lineCount", s."weightKg", s."routeId",
        (SELECT l."variantId"::text FROM "warehouse_shipment_lines" l WHERE l."shipmentId" = s."id" ORDER BY l."qty" DESC LIMIT 1) AS "topVariantId"
      FROM "warehouse_shipments" s JOIN "warehouse_orders" o ON o."orderId" = s."orderId"
      WHERE s."status" IN ('RELEASED','ALLOCATED','ASSIGNED','PICKING','PACKING','QC','READY_TO_DISPATCH','DISPATCHED','OUT_FOR_DELIVERY')
        ${inScope('s."warehouseId"', scope, warehouseId)}
      ORDER BY s."createdAt" DESC LIMIT ${limit}`;
  }

  /** Per warehouse in a range (W3.01 performance table). */
  warehousePerformance(scope: WarehouseScope, from: string, to: string) {
    return this.db.$queryRaw<
      {
        warehouseId: string;
        received: number;
        dispatched: number;
        onTimeDispatch: number;
        fulfilled: number;
        cycleMinSum: number;
        open: number;
        openExceptions: number;
      }[]
    >`
      SELECT w."warehouseId",
        COALESCE(d.received, 0)::int AS received, COALESCE(d.dispatched, 0)::int AS dispatched,
        COALESCE(d."onTimeDispatch", 0)::int AS "onTimeDispatch", COALESCE(d.fulfilled, 0)::int AS fulfilled,
        COALESCE(d."cycleMinSum", 0)::float8 AS "cycleMinSum",
        (SELECT count(*)::int FROM "warehouse_shipments" s WHERE s."warehouseId" = w."warehouseId"
          AND s."status" IN ('RELEASED','ALLOCATED','ASSIGNED','PICKING','PACKING','QC','READY_TO_DISPATCH')) AS open,
        (SELECT count(*)::int FROM "warehouse_exceptions" e WHERE e."warehouseId" = w."warehouseId" AND e."status" IN ('OPEN','IN_REVIEW')) AS "openExceptions"
      FROM (SELECT DISTINCT s."warehouseId" FROM "warehouse_shipments" s WHERE true ${inScope('s."warehouseId"', scope)}) w
      LEFT JOIN (
        SELECT "warehouseId", sum("received") AS received, sum("dispatched") AS dispatched,
          sum("onTimeDispatch") AS "onTimeDispatch", sum("fulfilled") AS fulfilled, sum("cycleMinSum") AS "cycleMinSum"
        FROM "warehouse_fulfilment_daily" WHERE "day" BETWEEN ${from}::date AND ${to}::date GROUP BY 1
      ) d ON d."warehouseId" = w."warehouseId"
      ORDER BY received DESC LIMIT 200`;
  }

  async stagedPallets(scope: WarehouseScope, warehouseId?: string): Promise<number> {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT COALESCE(sum(GREATEST(s."palletCount", 1)), 0)::int AS n FROM "warehouse_shipments" s
      WHERE s."status" = 'READY_TO_DISPATCH' ${inScope('s."warehouseId"', scope, warehouseId)}`;
    return r?.n ?? 0;
  }

  /** QC holds: shipments back in packing after a failed QC. */
  async qcHolds(scope: WarehouseScope, warehouseId?: string): Promise<number> {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "warehouse_shipments" s
      WHERE s."status" = 'PACKING' AND s."qcFirstPass" = false ${inScope('s."warehouseId"', scope, warehouseId)}`;
    return r?.n ?? 0;
  }

  // ── W3.08 dispatched / W3.19 bulk (dispatch module enriches with trips) ──

  private shipmentListWhere(
    scope: WarehouseScope,
    f: {
      statuses: readonly string[];
      q?: string;
      warehouseId?: string;
      customerId?: string;
      from?: Date;
      to?: Date;
      bulk?: boolean;
      directToFarm?: boolean;
    },
  ) {
    return Prisma.sql`WHERE s."status"::text = ANY(${[...f.statuses]}) ${inScope('s."warehouseId"', scope, f.warehouseId)}
      ${f.bulk === true ? Prisma.sql`AND s."isBulk"` : Prisma.empty}
      ${f.directToFarm === true ? Prisma.sql`AND w."type" = 'MOTHER'` : Prisma.empty}
      ${f.q === undefined ? Prisma.empty : Prisma.sql`AND (o."searchText" ILIKE ${`%${f.q.toLowerCase()}%`} OR s."shipmentNo" ILIKE ${`%${f.q}%`})`}
      ${f.customerId === undefined ? Prisma.empty : Prisma.sql`AND o."userId" = ${f.customerId}::uuid`}
      ${f.from === undefined ? Prisma.empty : Prisma.sql`AND COALESCE(s."dispatchedAt", s."createdAt") >= ${f.from}`}
      ${f.to === undefined ? Prisma.empty : Prisma.sql`AND COALESCE(s."dispatchedAt", s."createdAt") < ${f.to}`}`;
  }

  shipmentList(
    scope: WarehouseScope,
    f: Parameters<FulfilmentReadRepository['shipmentListWhere']>[1],
    page: { limit: number; offset: number | null; after: unknown[] | null },
  ) {
    const after =
      page.after === null || page.offset !== null
        ? Prisma.empty
        : Prisma.sql`AND s."id" < ${page.after[0]}::uuid`;
    return this.db.$queryRaw<
      {
        id: string;
        shipmentNo: string;
        orderId: string;
        orderNo: string;
        warehouseId: string;
        warehouseType: string;
        status: string;
        isBulk: boolean;
        holdActive: boolean;
        weightKg: Prisma.Decimal;
        value: Prisma.Decimal;
        lineCount: number;
        unitCount: number;
        palletCount: number;
        slaDueAt: Date | null;
        stagedAt: Date | null;
        dispatchedAt: Date | null;
        deliveredAt: Date | null;
        routeId: string | null;
        dockBookingId: string | null;
        customerName: string | null;
        farmName: string | null;
        district: string | null;
        pinCode: string | null;
      }[]
    >`
      SELECT s."id", s."shipmentNo", s."orderId", o."orderNo", s."warehouseId", w."type"::text AS "warehouseType",
        s."status"::text AS status, s."isBulk", s."holdActive", s."weightKg", s."value", s."lineCount", s."unitCount",
        s."palletCount", s."slaDueAt", s."stagedAt", s."dispatchedAt", s."deliveredAt", s."routeId", s."dockBookingId",
        o."customerName", o."farmName", o."district", o."pinCode"
      FROM "warehouse_shipments" s
      JOIN "warehouse_orders" o ON o."orderId" = s."orderId"
      JOIN "warehouse_warehouses" w ON w."id" = s."warehouseId"
      ${this.shipmentListWhere(scope, f)} ${after}
      ORDER BY s."id" DESC ${pageSql(page)}`;
  }

  async shipmentListCount(
    scope: WarehouseScope,
    f: Parameters<FulfilmentReadRepository['shipmentListWhere']>[1],
  ) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM "warehouse_shipments" s
        JOIN "warehouse_orders" o ON o."orderId" = s."orderId" JOIN "warehouse_warehouses" w ON w."id" = s."warehouseId"
        ${this.shipmentListWhere(scope, f)} LIMIT 10001) x`;
    return r?.n ?? 0;
  }

  /** Bulk consignments per status (+ direct-to-farm = from a MOTHER warehouse) and today's new. */
  async bulkCounts(scope: WarehouseScope, warehouseId: string | undefined, since: Date) {
    const rows = await this.db.$queryRaw<
      { status: string; n: number; direct: number; today: number }[]
    >`
      SELECT s."status"::text AS status, count(*)::int AS n,
        count(*) FILTER (WHERE w."type" = 'MOTHER')::int AS direct,
        count(*) FILTER (WHERE s."createdAt" >= ${since})::int AS today
      FROM "warehouse_shipments" s JOIN "warehouse_warehouses" w ON w."id" = s."warehouseId"
      WHERE s."isBulk" ${inScope('s."warehouseId"', scope, warehouseId)}
      GROUP BY 1`;
    return rows;
  }

  // ── W3.12 routing facts ──

  /** Orders placed in a period: total, auto-allocated (routed), and per routing rule. */
  async routedStats(from: Date, to: Date) {
    const [t] = await this.db.$queryRaw<{ orders: number; auto: number }[]>`
      SELECT count(*)::int AS orders, count(*) FILTER (WHERE "autoAllocated")::int AS auto
      FROM "warehouse_orders" WHERE "placedAt" >= ${from} AND "placedAt" < ${to}`;
    const byRule = await this.db.$queryRaw<{ ruleId: string; n: number }[]>`
      SELECT "routingRuleId"::text AS "ruleId", count(*)::int AS n FROM "warehouse_orders"
      WHERE "routingRuleId" IS NOT NULL AND "placedAt" >= ${from} AND "placedAt" < ${to}
      GROUP BY 1`;
    return { orders: t?.orders ?? 0, auto: t?.auto ?? 0, byRule };
  }

  /** Per warehouse: open shipments (on the floor) and today's released / dispatched counts. */
  nodeCounts(open: readonly string[], since: Date) {
    return this.db.$queryRaw<
      { warehouseId: string; open: number; releasedToday: number; dispatchedToday: number }[]
    >`
      SELECT "warehouseId"::text AS "warehouseId",
        count(*) FILTER (WHERE "status"::text = ANY(${[...open]}))::int AS open,
        count(*) FILTER (WHERE "releasedAt" >= ${since})::int AS "releasedToday",
        count(*) FILTER (WHERE "dispatchedAt" >= ${since})::int AS "dispatchedToday"
      FROM "warehouse_shipments"
      WHERE "status"::text = ANY(${[...open]}) OR "releasedAt" >= ${since} OR "dispatchedAt" >= ${since}
      GROUP BY 1`;
  }

  // ── W3.09 delivered / W3.10 fulfilled ──

  private deliveryWhere(
    scope: WarehouseScope,
    f: {
      statuses: readonly string[];
      q?: string;
      warehouseId?: string;
      customerId?: string;
      from?: Date;
      to?: Date;
      settlement?: string;
      overdueBefore?: Date;
    },
  ) {
    return Prisma.sql`WHERE s."status"::text = ANY(${[...f.statuses]}) ${inScope('s."warehouseId"', scope, f.warehouseId)}
      ${f.q === undefined ? Prisma.empty : Prisma.sql`AND (o."searchText" ILIKE ${`%${f.q.toLowerCase()}%`} OR s."shipmentNo" ILIKE ${`%${f.q}%`})`}
      ${f.customerId === undefined ? Prisma.empty : Prisma.sql`AND o."userId" = ${f.customerId}::uuid`}
      ${f.from === undefined ? Prisma.empty : Prisma.sql`AND COALESCE(s."fulfilledAt", s."deliveredAt", s."updatedAt") >= ${f.from}`}
      ${f.to === undefined ? Prisma.empty : Prisma.sql`AND COALESCE(s."fulfilledAt", s."deliveredAt", s."updatedAt") < ${f.to}`}
      ${f.settlement === 'SETTLED' ? Prisma.sql`AND s."settlementStatus" = 'SETTLED'` : Prisma.empty}
      ${f.settlement === 'PENDING' ? Prisma.sql`AND s."settlementStatus" = 'PENDING'` : Prisma.empty}
      ${f.overdueBefore === undefined ? Prisma.empty : Prisma.sql`AND s."settlementStatus" = 'PENDING' AND s."fulfilledAt" < ${f.overdueBefore}`}`;
  }

  deliveryList(
    scope: WarehouseScope,
    f: Parameters<FulfilmentReadRepository['deliveryWhere']>[1],
    page: { limit: number; offset: number | null; after: unknown[] | null },
  ) {
    const after =
      page.after === null || page.offset !== null
        ? Prisma.empty
        : Prisma.sql`AND s."id" < ${page.after[0]}::uuid`;
    return this.db.$queryRaw<
      {
        id: string;
        shipmentNo: string;
        orderId: string;
        orderNo: string;
        warehouseId: string;
        status: string;
        unitCount: number;
        weightKg: Prisma.Decimal;
        value: Prisma.Decimal;
        dispatchedAt: Date | null;
        deliveredAt: Date | null;
        fulfilledAt: Date | null;
        failedReason: string | null;
        deliveryAttempts: number;
        settlementStatus: string | null;
        settlementReason: string | null;
        settledAt: Date | null;
        customerName: string | null;
        farmName: string | null;
        district: string | null;
        paymentInstrument: string | null;
        receiverName: string | null;
        byOtp: boolean | null;
        otpVerifiedAt: Date | null;
        podMedia: number | null;
        onTime: boolean | null;
        overrideApproved: boolean | null;
        delivered: number;
        dispatched: number;
      }[]
    >`
      SELECT s."id", s."shipmentNo", s."orderId", o."orderNo", s."warehouseId", s."status"::text AS status, s."unitCount",
        s."weightKg", s."value", s."dispatchedAt", s."deliveredAt", s."fulfilledAt", s."failedReason", s."deliveryAttempts",
        s."settlementStatus", s."settlementReason", s."settledAt", o."customerName", o."farmName", o."district",
        o."paymentInstrument", p."receiverName", p."byOtp", p."otpVerifiedAt",
        COALESCE(array_length(p."mediaKeys", 1), 0) AS "podMedia", p."onTime",
        (p."overrideApprovedBy" IS NOT NULL) AS "overrideApproved",
        COALESCE((SELECT sum(l."deliveredQty") FROM "warehouse_shipment_lines" l WHERE l."shipmentId" = s."id"), 0)::int AS delivered,
        COALESCE((SELECT sum(l."dispatchedQty") FROM "warehouse_shipment_lines" l WHERE l."shipmentId" = s."id"), 0)::int AS dispatched
      FROM "warehouse_shipments" s
      JOIN "warehouse_orders" o ON o."orderId" = s."orderId"
      LEFT JOIN "warehouse_pods" p ON p."shipmentId" = s."id"
      ${this.deliveryWhere(scope, f)} ${after}
      ORDER BY s."id" DESC ${pageSql(page)}`;
  }

  async deliveryCount(
    scope: WarehouseScope,
    f: Parameters<FulfilmentReadRepository['deliveryWhere']>[1],
  ) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM "warehouse_shipments" s JOIN "warehouse_orders" o ON o."orderId" = s."orderId"
        ${this.deliveryWhere(scope, f)} LIMIT 10001) x`;
    return r?.n ?? 0;
  }

  async deliveredKpis(
    scope: WarehouseScope,
    warehouseId: string | undefined,
    from: Date,
    to: Date,
  ) {
    const [r] = await this.db.$queryRaw<
      {
        delivered: number;
        onTime: number;
        withPod: number;
        byOtp: number;
        failed: number;
        returned: number;
      }[]
    >`
      SELECT count(*) FILTER (WHERE s."status" IN ('DELIVERED','FULFILLED'))::int AS delivered,
        count(*) FILTER (WHERE s."status" IN ('DELIVERED','FULFILLED') AND p."onTime")::int AS "onTime",
        count(*) FILTER (WHERE s."status" IN ('DELIVERED','FULFILLED') AND COALESCE(array_length(p."mediaKeys", 1), 0) > 0)::int AS "withPod",
        count(*) FILTER (WHERE s."status" IN ('DELIVERED','FULFILLED') AND p."byOtp")::int AS "byOtp",
        count(*) FILTER (WHERE s."status" = 'DELIVERY_FAILED')::int AS failed,
        count(*) FILTER (WHERE s."status" = 'RETURNED_TO_WAREHOUSE')::int AS returned
      FROM "warehouse_shipments" s LEFT JOIN "warehouse_pods" p ON p."shipmentId" = s."id"
      WHERE COALESCE(s."deliveredAt", s."updatedAt") >= ${from} AND COALESCE(s."deliveredAt", s."updatedAt") < ${to}
        AND s."status" IN ('DELIVERED','FULFILLED','DELIVERY_FAILED','RETURNED_TO_WAREHOUSE')
        ${inScope('s."warehouseId"', scope, warehouseId)}`;
    return r ?? { delivered: 0, onTime: 0, withPod: 0, byOtp: 0, failed: 0, returned: 0 };
  }

  async fulfilledKpis(
    scope: WarehouseScope,
    warehouseId: string | undefined,
    from: Date,
    to: Date,
    overdueBefore: Date,
  ) {
    const [r] = await this.db.$queryRaw<
      {
        settled: number;
        settledValue: string;
        pending: number;
        pendingValue: string;
        overdue: number;
        total: number;
        avgSettleHours: number | null;
      }[]
    >`
      SELECT count(*) FILTER (WHERE s."settlementStatus" = 'SETTLED')::int AS settled,
        COALESCE(sum(s."value") FILTER (WHERE s."settlementStatus" = 'SETTLED'), 0)::text AS "settledValue",
        count(*) FILTER (WHERE s."settlementStatus" = 'PENDING')::int AS pending,
        COALESCE(sum(s."value") FILTER (WHERE s."settlementStatus" = 'PENDING'), 0)::text AS "pendingValue",
        count(*) FILTER (WHERE s."settlementStatus" = 'PENDING' AND s."fulfilledAt" < ${overdueBefore})::int AS overdue,
        count(*)::int AS total,
        avg(EXTRACT(EPOCH FROM (s."settledAt" - s."fulfilledAt")) / 3600) FILTER (WHERE s."settledAt" IS NOT NULL)::float8 AS "avgSettleHours"
      FROM "warehouse_shipments" s
      WHERE s."status" = 'FULFILLED' AND s."fulfilledAt" >= ${from} AND s."fulfilledAt" < ${to}
        ${inScope('s."warehouseId"', scope, warehouseId)}`;
    return (
      r ?? {
        settled: 0,
        settledValue: '0',
        pending: 0,
        pendingValue: '0',
        overdue: 0,
        total: 0,
        avgSettleHours: null,
      }
    );
  }

  /** Customer's shipments of one order (customer app). */
  customerShipments(userId: string, orderId: string | undefined, limit: number) {
    return this.db.$queryRaw<
      {
        id: string;
        orderId: string;
        orderNo: string;
        status: string;
        slaDueAt: Date | null;
        dispatchedAt: Date | null;
        outForDeliveryAt: Date | null;
        deliveredAt: Date | null;
        unitCount: number;
      }[]
    >`
      SELECT s."id", s."orderId", o."orderNo", s."status"::text AS status, s."slaDueAt", s."dispatchedAt",
        s."outForDeliveryAt", s."deliveredAt", s."unitCount"
      FROM "warehouse_shipments" s JOIN "warehouse_orders" o ON o."orderId" = s."orderId"
      WHERE o."userId" = ${userId}::uuid AND s."status" <> 'CANCELLED'
        ${orderId === undefined ? Prisma.empty : Prisma.sql`AND s."orderId" = ${orderId}::uuid`}
      ORDER BY s."createdAt" DESC LIMIT ${limit}`;
  }

  // ── W3.11 exceptions ──

  private exceptionWhere(
    scope: WarehouseScope,
    f: {
      type?: string;
      status?: string;
      severity?: string;
      q?: string;
      warehouseId?: string;
      customerId?: string;
      fromAt?: Date;
      toAt?: Date;
    },
  ) {
    return Prisma.sql`WHERE true ${inScope('e."warehouseId"', scope, f.warehouseId)}
      ${f.type === undefined || f.type === 'all' ? Prisma.empty : Prisma.sql`AND e."type"::text = ${f.type}`}
      ${f.status === undefined ? Prisma.sql`AND e."status" IN ('OPEN','IN_REVIEW')` : f.status === 'all' ? Prisma.empty : Prisma.sql`AND e."status"::text = ${f.status}`}
      ${f.severity === undefined ? Prisma.empty : Prisma.sql`AND e."severity"::text = ${f.severity}`}
      ${f.q === undefined ? Prisma.empty : Prisma.sql`AND (e."exNo" ILIKE ${`%${f.q}%`} OR e."title" ILIKE ${`%${f.q}%`} OR o."searchText" ILIKE ${`%${f.q.toLowerCase()}%`})`}
      ${f.customerId === undefined ? Prisma.empty : Prisma.sql`AND o."userId" = ${f.customerId}::uuid`}
      ${f.fromAt === undefined ? Prisma.empty : Prisma.sql`AND e."createdAt" >= ${f.fromAt}`}
      ${f.toAt === undefined ? Prisma.empty : Prisma.sql`AND e."createdAt" < ${f.toAt}`}`;
  }

  exceptions(
    scope: WarehouseScope,
    f: Parameters<FulfilmentReadRepository['exceptionWhere']>[1],
    page: { limit: number; offset: number | null; after: unknown[] | null },
  ) {
    const after =
      page.after === null || page.offset !== null
        ? Prisma.empty
        : Prisma.sql`AND (COALESCE(e."slaDueAt", 'infinity'::timestamp), e."id") > (${page.after[0] === null ? new Date('9999-12-31') : new Date(page.after[0] as string)}, ${page.after[1]}::uuid)`;
    return this.db.$queryRaw<
      (Prisma.WmsExceptionGetPayload<object> & {
        orderNo: string | null;
        customerName: string | null;
        customerPoRef: string | null;
        orderCancelled: boolean;
        sku: string | null;
        productName: string | null;
        warehouseCode: string | null;
        warehouseName: string | null;
        packageSummary: string | null;
      })[]
    >`
      SELECT e.*, o."orderNo", o."customerName", o."customerPoRef",
        (o."orderStatus" IN ('CANCELLED','REJECTED','FAILED')) AS "orderCancelled",
        v."sku", v."name" AS "productName", w."code" AS "warehouseCode", w."name" AS "warehouseName",
        (SELECT count(*)::text || ' ' || initcap(lower(max(p."packageType"::text))) || 's' FROM "warehouse_packages" p WHERE p."shipmentId" = e."shipmentId" HAVING count(*) > 0) AS "packageSummary"
      FROM "warehouse_exceptions" e
      LEFT JOIN "warehouse_orders" o ON o."orderId" = e."orderId"
      LEFT JOIN "warehouse_variant_projection" v ON v."variantId" = e."variantId"
      LEFT JOIN "warehouse_warehouses" w ON w."id" = e."warehouseId"
      ${this.exceptionWhere(scope, f)} ${after}
      ORDER BY COALESCE(e."slaDueAt", 'infinity'::timestamp), e."id"
      ${pageSql(page)}`;
  }

  async exceptionsCount(
    scope: WarehouseScope,
    f: Parameters<FulfilmentReadRepository['exceptionWhere']>[1],
  ) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM "warehouse_exceptions" e LEFT JOIN "warehouse_orders" o ON o."orderId" = e."orderId"
        ${this.exceptionWhere(scope, f)} LIMIT 10001) x`;
    return r?.n ?? 0;
  }

  exceptionContext(ids: readonly string[]) {
    return this.db.$queryRaw<
      {
        orderNo: string | null;
        customerName: string | null;
        customerPoRef: string | null;
        orderCancelled: boolean;
        sku: string | null;
        productName: string | null;
        warehouseCode: string | null;
        warehouseName: string | null;
      }[]
    >`
      SELECT o."orderNo", o."customerName", o."customerPoRef",
        COALESCE(o."orderStatus" IN ('CANCELLED','REJECTED','FAILED'), false) AS "orderCancelled",
        v."sku", v."name" AS "productName", w."code" AS "warehouseCode", w."name" AS "warehouseName"
      FROM "warehouse_exceptions" e
      LEFT JOIN "warehouse_orders" o ON o."orderId" = e."orderId"
      LEFT JOIN "warehouse_variant_projection" v ON v."variantId" = e."variantId"
      LEFT JOIN "warehouse_warehouses" w ON w."id" = e."warehouseId"
      WHERE e."id" = ANY(${[...ids]}::uuid[])`;
  }

  async exceptionKpis(
    scope: WarehouseScope,
    warehouseId: string | undefined,
    since: Date,
    range: { from?: Date; to?: Date },
  ) {
    const rows = await this.db.$queryRaw<{ type: string; n: number }[]>`
      SELECT e."type"::text AS type, count(*)::int AS n FROM "warehouse_exceptions" e
      WHERE e."status" IN ('OPEN','IN_REVIEW') ${inScope('e."warehouseId"', scope, warehouseId)}
        ${range.from === undefined ? Prisma.empty : Prisma.sql`AND e."createdAt" >= ${range.from}`}
        ${range.to === undefined ? Prisma.empty : Prisma.sql`AND e."createdAt" < ${range.to}`}
      GROUP BY 1`;
    const [k] = await this.db.$queryRaw<
      {
        open: number;
        critical: number;
        overdue: number;
        sinceToday: number;
        impactedKg: number;
        restockOrders: number;
        dockReturned: number;
      }[]
    >`
      SELECT count(*) FILTER (WHERE e."status" IN ('OPEN','IN_REVIEW'))::int AS open,
        count(*) FILTER (WHERE e."status" IN ('OPEN','IN_REVIEW') AND e."severity" = 'CRITICAL')::int AS critical,
        count(*) FILTER (WHERE e."status" IN ('OPEN','IN_REVIEW') AND e."slaDueAt" < now())::int AS overdue,
        count(*) FILTER (WHERE e."createdAt" >= ${since})::int AS "sinceToday",
        COALESCE(sum(e."impactedKg") FILTER (WHERE e."status" IN ('OPEN','IN_REVIEW')), 0)::float8 AS "impactedKg",
        count(DISTINCT e."orderId") FILTER (WHERE e."status" IN ('OPEN','IN_REVIEW') AND e."type" = 'SHORTAGE')::int AS "restockOrders",
        count(*) FILTER (WHERE e."status" IN ('OPEN','IN_REVIEW') AND e."type" = 'DELIVERY' AND e."reportedLocation" ILIKE 'dock%')::int AS "dockReturned"
      FROM "warehouse_exceptions" e WHERE true ${inScope('e."warehouseId"', scope, warehouseId)}`;
    const reroutes = await this.db.$queryRaw<
      {
        id: string;
        orderId: string;
        orderNo: string | null;
        status: string;
        toWarehouseId: string;
      }[]
    >`
      SELECT r."id", r."orderId", o."orderNo", r."status"::text AS status, r."toWarehouseId"
      FROM "warehouse_reallocations" r LEFT JOIN "warehouse_orders" o ON o."orderId" = r."orderId"
      WHERE r."status" IN ('PENDING','INVENTORY_DONE') ${inScope('r."toWarehouseId"', scope, warehouseId)}
      ORDER BY r."createdAt" DESC LIMIT 5`;
    const [routed] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "warehouse_reallocations" r WHERE r."status" = 'COMPLETED' AND r."createdAt" >= ${range.from ?? since}
        ${inScope('r."toWarehouseId"', scope, warehouseId)}`;
    return {
      ...(k ?? {
        open: 0,
        critical: 0,
        overdue: 0,
        sinceToday: 0,
        impactedKg: 0,
        restockOrders: 0,
        dockReturned: 0,
      }),
      byType: Object.fromEntries(rows.map((r) => [r.type, r.n])) as Record<string, number>,
      reroutes,
      routed: routed?.n ?? 0,
    };
  }

  // ── W4.05 reserved stock ──

  async reservedKpis(scope: WarehouseScope, warehouseId?: string) {
    const [r] = await this.db.$queryRaw<
      { reserved: number; picked: number; batches: number; unallocated: number }[]
    >`
      SELECT
        COALESCE((SELECT sum(a."qty" - a."pickedQty") FROM "warehouse_lot_allocations" a WHERE a."status" = 'ALLOCATED' ${inScope('a."warehouseId"', scope, warehouseId)}), 0)::int AS reserved,
        COALESCE((SELECT sum(CASE WHEN a."status" = 'ALLOCATED' THEN a."pickedQty" ELSE a."qty" END) FROM "warehouse_lot_allocations" a WHERE a."status" IN ('ALLOCATED','PICKED','PACKED') ${inScope('a."warehouseId"', scope, warehouseId)}), 0)::int AS picked,
        (SELECT count(DISTINCT a."batchId") FROM "warehouse_lot_allocations" a WHERE a."status" IN ('ALLOCATED','PICKED','PACKED') ${inScope('a."warehouseId"', scope, warehouseId)})::int AS batches,
        COALESCE((SELECT sum(l."qty" - l."cancelledQty" - l."allocatedQty") FROM "warehouse_shipment_lines" l JOIN "warehouse_shipments" s ON s."id" = l."shipmentId"
          WHERE s."status" IN ('PENDING_RELEASE','RELEASED','ALLOCATED','ASSIGNED') AND l."qty" - l."cancelledQty" - l."allocatedQty" > 0 ${inScope('s."warehouseId"', scope, warehouseId)}), 0)::int AS unallocated`;
    return r ?? { reserved: 0, picked: 0, batches: 0, unallocated: 0 };
  }

  reservations(
    scope: WarehouseScope,
    f: {
      tab: 'active' | 'picked' | 'released';
      warehouseId?: string;
      variantId?: string;
      q?: string;
    },
    page: { limit: number; offset: number | null; after: unknown[] | null },
  ) {
    const status =
      f.tab === 'active'
        ? Prisma.sql`AND a."status" = 'ALLOCATED'`
        : f.tab === 'picked'
          ? Prisma.sql`AND a."status" IN ('PICKED','PACKED')`
          : Prisma.sql`AND a."status" IN ('RELEASED','ISSUED')`;
    const after =
      page.after === null || page.offset !== null
        ? Prisma.empty
        : Prisma.sql`AND a."id" < ${page.after[0]}::uuid`;
    return this.db.$queryRaw<
      {
        id: string;
        shipmentId: string;
        shipmentNo: string;
        orderId: string;
        orderNo: string;
        customerName: string | null;
        warehouseId: string;
        variantId: string;
        sku: string | null;
        productName: string | null;
        batchId: string;
        batchNo: string | null;
        expiryDate: Date | null;
        binId: string | null;
        qty: number;
        pickedQty: number;
        status: string;
        soft: boolean;
        isFefo: boolean;
        createdAt: Date;
        releasedAt: Date | null;
        releaseReason: string | null;
        shipmentStatus: string;
      }[]
    >`
      SELECT a."id", a."shipmentId", s."shipmentNo", s."orderId", o."orderNo", o."customerName", a."warehouseId",
        a."variantId", v."sku", v."name" AS "productName", a."batchId", b."batchNo", b."expiryDate", a."binId",
        a."qty", a."pickedQty", a."status"::text AS status, a."soft", a."isFefo", a."createdAt", a."releasedAt",
        a."releaseReason", s."status"::text AS "shipmentStatus"
      FROM "warehouse_lot_allocations" a
      JOIN "warehouse_shipments" s ON s."id" = a."shipmentId"
      JOIN "warehouse_orders" o ON o."orderId" = s."orderId"
      LEFT JOIN "warehouse_variant_projection" v ON v."variantId" = a."variantId"
      LEFT JOIN "warehouse_batches" b ON b."id" = a."batchId"
      WHERE true ${status} ${inScope('a."warehouseId"', scope, f.warehouseId)}
        ${f.variantId === undefined ? Prisma.empty : Prisma.sql`AND a."variantId" = ${f.variantId}::uuid`}
        ${f.q === undefined ? Prisma.empty : Prisma.sql`AND (o."searchText" ILIKE ${`%${f.q.toLowerCase()}%`} OR v."searchText" ILIKE ${`%${f.q.toLowerCase()}%`} OR b."batchNo" ILIKE ${`%${f.q}%`})`}
        ${after}
      ORDER BY a."id" DESC ${pageSql(page)}`;
  }

  /** Order demand not yet FEFO-allocated (W4.05 "Not allocated" rows). */
  unallocatedDemand(
    scope: WarehouseScope,
    f: { warehouseId?: string; variantId?: string },
    limit: number,
  ) {
    return this.db.$queryRaw<
      {
        shipmentId: string;
        shipmentNo: string;
        orderId: string;
        orderNo: string;
        warehouseId: string;
        variantId: string;
        sku: string | null;
        productName: string | null;
        qty: number;
        status: string;
      }[]
    >`
      SELECT s."id" AS "shipmentId", s."shipmentNo", s."orderId", o."orderNo", s."warehouseId", l."variantId",
        v."sku", v."name" AS "productName", (l."qty" - l."cancelledQty" - l."allocatedQty")::int AS qty, s."status"::text AS status
      FROM "warehouse_shipment_lines" l
      JOIN "warehouse_shipments" s ON s."id" = l."shipmentId"
      JOIN "warehouse_orders" o ON o."orderId" = s."orderId"
      LEFT JOIN "warehouse_variant_projection" v ON v."variantId" = l."variantId"
      WHERE s."status" IN ('PENDING_RELEASE','RELEASED','ALLOCATED','ASSIGNED') AND l."qty" - l."cancelledQty" - l."allocatedQty" > 0
        ${inScope('s."warehouseId"', scope, f.warehouseId)}
        ${f.variantId === undefined ? Prisma.empty : Prisma.sql`AND l."variantId" = ${f.variantId}::uuid`}
      ORDER BY s."slaDueAt" NULLS LAST LIMIT ${limit}`;
  }

  /** Readiness inputs: open demand vs binned unexpired AVAILABLE stock, per warehouse × SKU. */
  async readiness(scope: WarehouseScope, warehouseId?: string) {
    const [r] = await this.db.$queryRaw<{ demand: number; allocated: number; covered: number }[]>`
      WITH d AS (
        SELECT s."warehouseId", l."variantId", sum(l."qty" - l."cancelledQty" - l."allocatedQty")::int AS need, sum(l."allocatedQty")::int AS alloc
        FROM "warehouse_shipment_lines" l JOIN "warehouse_shipments" s ON s."id" = l."shipmentId"
        WHERE s."status" IN ('RELEASED','ALLOCATED','ASSIGNED') ${inScope('s."warehouseId"', scope, warehouseId)}
        GROUP BY 1, 2
      ), a AS (
        SELECT p."warehouseId", p."variantId", sum(p."available")::int AS avail
        FROM "warehouse_stock_positions" p JOIN d ON d."warehouseId" = p."warehouseId" AND d."variantId" = p."variantId"
        WHERE p."binId" IS NOT NULL AND (p."expiryDate" IS NULL OR p."expiryDate" >= current_date)
        GROUP BY 1, 2
      )
      SELECT COALESCE(sum(d.need), 0)::int AS demand, COALESCE(sum(d.alloc), 0)::int AS allocated,
        COALESCE(sum(LEAST(d.need, COALESCE(a.avail, 0))), 0)::int AS covered
      FROM d LEFT JOIN a ON a."warehouseId" = d."warehouseId" AND a."variantId" = d."variantId"`;
    return r ?? { demand: 0, allocated: 0, covered: 0 };
  }

  // ── jobs ──

  /** Shipments near / past their SLA that are not flagged yet (sla-watch). */
  slaCandidates(limit: number) {
    return this.db.$queryRaw<
      { id: string; warehouseId: string; orderId: string; slaDueAt: Date; atRisk: boolean }[]
    >`
      SELECT s."id", s."warehouseId", s."orderId", s."slaDueAt", s."atRisk" FROM "warehouse_shipments" s
      WHERE s."status" IN ('RELEASED','ALLOCATED','ASSIGNED','PICKING','PACKING','QC','READY_TO_DISPATCH')
        AND s."slaDueAt" < now() + interval '60 minutes'
      ORDER BY s."slaDueAt" LIMIT ${limit}`;
  }

  /** WMS open quantity per (order, SKU) at a warehouse (allocation reconcile). */
  /** OPEN backorders at a warehouse (allocation reconcile). */
  openBackorders(warehouseId: string) {
    return this.db.$queryRaw<{ orderId: string; variantId: string; qty: number }[]>`
      SELECT "orderId"::text AS "orderId", "variantId"::text AS "variantId", sum("qty")::int AS qty
      FROM "warehouse_backorders"
      WHERE "warehouseId" = ${warehouseId}::uuid AND "status"::text = 'OPEN'
      GROUP BY 1, 2`;
  }

  openShipmentLines(warehouseId: string) {
    return this.db.$queryRaw<
      {
        shipmentId: string;
        orderId: string;
        status: string;
        lineNo: number;
        variantId: string;
        active: number;
        allocated: number;
        picked: number;
      }[]
    >`
      SELECT s."id" AS "shipmentId", s."orderId", s."status"::text AS status, l."lineNo", l."variantId",
        (l."qty" - l."cancelledQty" - l."dispatchedQty")::int AS active, l."allocatedQty" AS allocated, l."pickedQty" AS picked
      FROM "warehouse_shipment_lines" l JOIN "warehouse_shipments" s ON s."id" = l."shipmentId"
      WHERE s."warehouseId" = ${warehouseId}::uuid
        AND s."status" IN ('PENDING_RELEASE','RELEASED','ALLOCATED','ASSIGNED','PICKING','PACKING','QC','READY_TO_DISPATCH')`;
  }

  /** Dispatched lines of the last days at a warehouse (reconcile: issue still pending?). */
  dispatchedLines(warehouseId: string, since: Date) {
    return this.db.$queryRaw<
      { shipmentId: string; orderId: string; variantId: string; qty: number; dispatchedAt: Date }[]
    >`
      SELECT s."id" AS "shipmentId", s."orderId", l."variantId", l."dispatchedQty" AS qty, s."dispatchedAt"
      FROM "warehouse_shipment_lines" l JOIN "warehouse_shipments" s ON s."id" = l."shipmentId"
      WHERE s."warehouseId" = ${warehouseId}::uuid AND s."dispatchId" IS NOT NULL AND s."dispatchedAt" >= ${since}
        AND l."dispatchedQty" > 0`;
  }

  warehousesWithShipments() {
    return this.db.$queryRaw<{ warehouseId: string }[]>`
      SELECT DISTINCT s."warehouseId" FROM "warehouse_shipments" s
      WHERE s."status" IN ('PENDING_RELEASE','RELEASED','ALLOCATED','ASSIGNED','PICKING','PACKING','QC','READY_TO_DISPATCH')`;
  }

  /** Rebuild of one IST day of counters from the shipment timestamps (daily-rollup job). */
  async rebuildDay(day: string) {
    const start = new Date(`${day}T00:00:00+05:30`);
    const end = new Date(start.getTime() + 86_400_000);
    await this.db.$executeRaw`
      INSERT INTO "warehouse_fulfilment_daily" ("warehouseId", "day", "received", "released", "dispatched", "onTimeDispatch",
        "delivered", "fulfilled", "cancelled", "cycleMinSum", "valueFulfilled", "updatedAt")
      SELECT s."warehouseId", ${day}::date,
        count(*) FILTER (WHERE s."createdAt" >= ${start} AND s."createdAt" < ${end}),
        count(*) FILTER (WHERE s."releasedAt" >= ${start} AND s."releasedAt" < ${end}),
        count(*) FILTER (WHERE s."dispatchedAt" >= ${start} AND s."dispatchedAt" < ${end}),
        count(*) FILTER (WHERE s."dispatchedAt" >= ${start} AND s."dispatchedAt" < ${end} AND (s."slaDueAt" IS NULL OR s."dispatchedAt" <= s."slaDueAt")),
        count(*) FILTER (WHERE s."deliveredAt" >= ${start} AND s."deliveredAt" < ${end}),
        count(*) FILTER (WHERE s."fulfilledAt" >= ${start} AND s."fulfilledAt" < ${end}),
        count(*) FILTER (WHERE s."cancelledAt" >= ${start} AND s."cancelledAt" < ${end}),
        COALESCE(sum(EXTRACT(EPOCH FROM (s."dispatchedAt" - s."releasedAt")) / 60) FILTER (WHERE s."dispatchedAt" >= ${start} AND s."dispatchedAt" < ${end} AND s."releasedAt" IS NOT NULL), 0)::bigint,
        COALESCE(sum(s."value") FILTER (WHERE s."fulfilledAt" >= ${start} AND s."fulfilledAt" < ${end}), 0),
        now()
      FROM "warehouse_shipments" s
      WHERE (s."createdAt" >= ${start} AND s."createdAt" < ${end}) OR (s."releasedAt" >= ${start} AND s."releasedAt" < ${end})
        OR (s."dispatchedAt" >= ${start} AND s."dispatchedAt" < ${end}) OR (s."deliveredAt" >= ${start} AND s."deliveredAt" < ${end})
        OR (s."fulfilledAt" >= ${start} AND s."fulfilledAt" < ${end}) OR (s."cancelledAt" >= ${start} AND s."cancelledAt" < ${end})
      GROUP BY s."warehouseId"
      ON CONFLICT ("warehouseId", "day") DO UPDATE SET "received" = EXCLUDED."received", "released" = EXCLUDED."released",
        "dispatched" = EXCLUDED."dispatched", "onTimeDispatch" = EXCLUDED."onTimeDispatch", "delivered" = EXCLUDED."delivered",
        "fulfilled" = EXCLUDED."fulfilled", "cancelled" = EXCLUDED."cancelled", "cycleMinSum" = EXCLUDED."cycleMinSum",
        "valueFulfilled" = EXCLUDED."valueFulfilled", "updatedAt" = now()`;
  }

  /** Outbox backlog of this service (sync status). */
  async outboxLag(): Promise<{ pending: number; oldestAt: Date | null }> {
    const [r] = await this.db.$queryRaw<{ pending: number; oldestAt: Date | null }[]>`
      SELECT count(*)::int AS pending, min("createdAt") AS "oldestAt" FROM "outbox_events"
      WHERE "publishedAt" IS NULL AND ("type" LIKE 'warehouse.%' OR "type" LIKE 'shipment.%')`;
    return r ?? { pending: 0, oldestAt: null };
  }

  /** Restricted SKU quantities a customer ordered in a period (period limit, W3.16 ledger). */
  customerPeriodQty(userId: string, variantIds: readonly string[], since: Date) {
    if (variantIds.length === 0) return Promise.resolve([]);
    return this.db.$queryRaw<{ variantId: string; qty: number; orders: number }[]>`
      SELECT l."variantId"::text AS "variantId", sum(l."qty" - l."cancelledQty")::int AS qty, count(DISTINCT o."orderId")::int AS orders
      FROM "warehouse_order_lines" l JOIN "warehouse_orders" o ON o."orderId" = l."orderId"
      WHERE o."userId" = ${userId}::uuid AND o."placedAt" >= ${since} AND l."variantId" = ANY(${[...variantIds]}::uuid[])
        AND o."orderStatus" NOT IN ('CANCELLED','REJECTED','FAILED')
      GROUP BY 1`;
  }
}
