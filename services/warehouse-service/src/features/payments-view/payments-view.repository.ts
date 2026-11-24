import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { WarehouseScope } from '../../middleware/access.js';

export type LedgerTab = 'all' | 'paid' | 'pending' | 'refunds' | 'failed' | 'held';

const TAB: Record<LedgerTab, Prisma.Sql> = {
  all: Prisma.empty,
  paid: Prisma.sql`AND o."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED')`,
  pending: Prisma.sql`AND o."paymentStatus" = 'PENDING'`,
  refunds: Prisma.sql`AND COALESCE(o."refundStatus", 'NONE') <> 'NONE'`,
  failed: Prisma.sql`AND o."paymentStatus" IN ('FAILED', 'EXPIRED')`,
  held: Prisma.sql`AND o."holdActive"`,
};

/** Orders visible to the caller: an order with a shipment at one of their warehouses. */
const visible = (scope: WarehouseScope, warehouseId?: string): Prisma.Sql => {
  if (warehouseId !== undefined)
    return Prisma.sql`AND EXISTS (SELECT 1 FROM "warehouse_shipments" s WHERE s."orderId" = o."orderId" AND s."warehouseId" = ${warehouseId}::uuid)`;
  if (scope === 'ALL') return Prisma.empty;
  return Prisma.sql`AND EXISTS (SELECT 1 FROM "warehouse_shipments" s WHERE s."orderId" = o."orderId" AND s."warehouseId" = ANY(${[...scope]}::uuid[]))`;
};

export interface LedgerRow {
  orderId: string;
  orderNo: string | null;
  userId: string | null;
  customerName: string | null;
  farmName: string | null;
  farmCode: string | null;
  customerPoRef: string | null;
  paymentStatus: string;
  paymentMethod: string | null;
  paymentInstrument: string | null;
  paymentRefMasked: string | null;
  refundStatus: string | null;
  grandTotal: string;
  refunded: string | null;
  holdActive: boolean;
  orderStatus: string | null;
  placedAt: Date;
  paidAt: Date | null;
}

/**
 * Payments view (D-57b W3.18, prepaid): read-only reporting over the fulfilment order read model
 * (payment + refund status copied from order-service facts). Credit / COD do not exist.
 */
export class PaymentsViewRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async kpis(scope: WarehouseScope, warehouseId: string | undefined, from: Date, to: Date) {
    const [r] = await this.db.$queryRaw<
      {
        orders: number;
        paid: number;
        paidValue: string | null;
        pending: number;
        pendingValue: string | null;
        failed: number;
        refundClaims: number;
        refundOpen: number;
        refundedValue: string | null;
        held: number;
        customers: number;
      }[]
    >`
      SELECT count(*)::int AS orders,
        count(*) FILTER (WHERE o."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED'))::int AS paid,
        sum(o."grandTotal") FILTER (WHERE o."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED'))::text AS "paidValue",
        count(*) FILTER (WHERE o."paymentStatus" = 'PENDING')::int AS pending,
        sum(o."grandTotal") FILTER (WHERE o."paymentStatus" = 'PENDING')::text AS "pendingValue",
        count(*) FILTER (WHERE o."paymentStatus" IN ('FAILED', 'EXPIRED'))::int AS failed,
        count(*) FILTER (WHERE COALESCE(o."refundStatus", 'NONE') <> 'NONE')::int AS "refundClaims",
        count(*) FILTER (WHERE o."refundStatus" IN ('REQUESTED', 'IN_PROGRESS', 'ACTION_REQUIRED'))::int AS "refundOpen",
        sum(COALESCE((o."totals"->>'refundedAmount')::numeric, 0))::text AS "refundedValue",
        count(*) FILTER (WHERE o."holdActive")::int AS held,
        count(DISTINCT o."userId")::int AS customers
      FROM "warehouse_orders" o
      WHERE o."placedAt" >= ${from} AND o."placedAt" < ${to} ${visible(scope, warehouseId)}`;
    return r;
  }

  orders(
    scope: WarehouseScope,
    f: { tab: LedgerTab; q?: string; warehouseId?: string; method?: string; userId?: string },
    page: { limit: number; offset: number | null; after: readonly unknown[] | null },
  ): Promise<LedgerRow[]> {
    return this.db.$queryRaw<LedgerRow[]>`
      SELECT o."orderId"::text AS "orderId", o."orderNo", o."userId"::text AS "userId", o."customerName",
        o."farmName", o."farmCode", o."customerPoRef", o."paymentStatus", o."paymentMethod",
        o."paymentInstrument", o."paymentRefMasked", o."refundStatus", o."grandTotal"::text AS "grandTotal",
        (o."totals"->>'refundedAmount') AS refunded, o."holdActive", o."orderStatus", o."placedAt", o."paidAt"
      FROM "warehouse_orders" o
      WHERE true ${TAB[f.tab]} ${visible(scope, f.warehouseId)}
      ${f.q === undefined ? Prisma.empty : Prisma.sql`AND o."searchText" ILIKE ${`%${f.q.toLowerCase()}%`}`}
      ${f.method === undefined ? Prisma.empty : Prisma.sql`AND lower(o."paymentInstrument") = ${f.method.toLowerCase()}`}
      ${f.userId === undefined ? Prisma.empty : Prisma.sql`AND o."userId" = ${f.userId}::uuid`}
      ${page.after === null ? Prisma.empty : Prisma.sql`AND (o."placedAt", o."orderId") < (${page.after[0]}::timestamptz, ${page.after[1]}::uuid)`}
      ORDER BY o."placedAt" DESC, o."orderId" DESC
      LIMIT ${page.limit + 1} ${page.offset === null ? Prisma.empty : Prisma.sql`OFFSET ${page.offset}`}`;
  }

  async count(
    scope: WarehouseScope,
    f: { tab: LedgerTab; q?: string; warehouseId?: string; method?: string },
  ): Promise<number> {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM "warehouse_orders" o
      WHERE true ${TAB[f.tab]} ${visible(scope, f.warehouseId)}
      ${f.q === undefined ? Prisma.empty : Prisma.sql`AND o."searchText" ILIKE ${`%${f.q.toLowerCase()}%`}`}
      ${f.method === undefined ? Prisma.empty : Prisma.sql`AND lower(o."paymentInstrument") = ${f.method.toLowerCase()}`}
      LIMIT 10001) x`;
    return r?.n ?? 0;
  }

  async tabCounts(scope: WarehouseScope, warehouseId?: string) {
    const [r] = await this.db.$queryRaw<
      {
        all: number;
        paid: number;
        pending: number;
        refunds: number;
        failed: number;
        held: number;
      }[]
    >`
      SELECT count(*)::int AS "all",
        count(*) FILTER (WHERE o."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED'))::int AS paid,
        count(*) FILTER (WHERE o."paymentStatus" = 'PENDING')::int AS pending,
        count(*) FILTER (WHERE COALESCE(o."refundStatus", 'NONE') <> 'NONE')::int AS refunds,
        count(*) FILTER (WHERE o."paymentStatus" IN ('FAILED', 'EXPIRED'))::int AS failed,
        count(*) FILTER (WHERE o."holdActive")::int AS held
      FROM "warehouse_orders" o WHERE true ${visible(scope, warehouseId)}`;
    return r;
  }

  async customer(scope: WarehouseScope, userId: string) {
    const [r] = await this.db.$queryRaw<
      {
        orders: number;
        paid: number;
        paidValue: string | null;
        refundedValue: string | null;
        refundClaims: number;
        firstOrderAt: Date | null;
        lastOrderAt: Date | null;
        customerName: string | null;
        farmName: string | null;
        farmCode: string | null;
      }[]
    >`
      SELECT count(*)::int AS orders,
        count(*) FILTER (WHERE o."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'))::int AS paid,
        sum(o."grandTotal") FILTER (WHERE o."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'))::text AS "paidValue",
        sum(COALESCE((o."totals"->>'refundedAmount')::numeric, 0))::text AS "refundedValue",
        count(*) FILTER (WHERE COALESCE(o."refundStatus", 'NONE') <> 'NONE')::int AS "refundClaims",
        min(o."placedAt") AS "firstOrderAt", max(o."placedAt") AS "lastOrderAt",
        (array_agg(o."customerName" ORDER BY o."placedAt" DESC))[1] AS "customerName",
        (array_agg(o."farmName" ORDER BY o."placedAt" DESC))[1] AS "farmName",
        (array_agg(o."farmCode" ORDER BY o."placedAt" DESC))[1] AS "farmCode"
      FROM "warehouse_orders" o WHERE o."userId" = ${userId}::uuid ${visible(scope)}`;
    return r;
  }
}
