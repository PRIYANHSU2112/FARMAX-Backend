import { withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';
import type { WarehouseScope } from '../../middleware/access.js';

/** Totals of the 9 status columns (+ near expiry / unknown expiry on the summary). */
export interface Totals {
  qcHold: number;
  available: number;
  reserved: number;
  picked: number;
  packed: number;
  quarantined: number;
  damaged: number;
  expired: number;
  returned: number;
  nearExpiry: number;
  expiryUnknown: number;
}

const SUM_COLS = Prisma.raw(
  `COALESCE(sum("qcHold"),0)::int AS "qcHold", COALESCE(sum("available"),0)::int AS "available",
   COALESCE(sum("reserved"),0)::int AS "reserved", COALESCE(sum("picked"),0)::int AS "picked",
   COALESCE(sum("packed"),0)::int AS "packed", COALESCE(sum("quarantined"),0)::int AS "quarantined",
   COALESCE(sum("damaged"),0)::int AS "damaged", COALESCE(sum("expired"),0)::int AS "expired",
   COALESCE(sum("returned"),0)::int AS "returned"`,
);
const COLS9 = [
  'qcHold',
  'available',
  'reserved',
  'picked',
  'packed',
  'quarantined',
  'damaged',
  'expired',
  'returned',
];
const PHYS = `(${COLS9.map((c) => `"${c}"`).join('+')})`;
/** Physical on-hand expression for a table alias: (p."qcHold"+p."available"+…). */
const phys = (alias: string): string => `(${COLS9.map((c) => `${alias}."${c}"`).join('+')})`;

const EMPTY: Totals = {
  qcHold: 0,
  available: 0,
  reserved: 0,
  picked: 0,
  packed: 0,
  quarantined: 0,
  damaged: 0,
  expired: 0,
  returned: 0,
  nearExpiry: 0,
  expiryUnknown: 0,
};

/** `AND <col> IN scope` (+ optional single warehouse). */
export const inScope = (col: string, scope: WarehouseScope, warehouseId?: string): Prisma.Sql => {
  const c = Prisma.raw(col);
  if (warehouseId !== undefined) return Prisma.sql`AND ${c} = ${warehouseId}::uuid`;
  if (scope === 'ALL') return Prisma.empty;
  return Prisma.sql`AND ${c} = ANY(${[...scope]}::uuid[])`;
};

/** Keyset helper: `AND (a, b) > (x, y)` (or `<` for DESC). */
const after = (cols: string, values: readonly unknown[] | null, desc = false): Prisma.Sql =>
  values === null
    ? Prisma.empty
    : Prisma.sql`AND (${Prisma.raw(cols)}) ${Prisma.raw(desc ? '<' : '>')} (${Prisma.join(
        values.map((v) => Prisma.sql`${v}`),
      )})`;

export interface RecordFilter {
  q?: string;
  brandId?: string;
  categoryId?: string;
  vendorId?: string;
  batchNo?: string;
  binIds?: readonly string[];
  expiry?: 'expired' | '30d' | '90d' | 'later' | 'unknown';
  status?: string;
  minAvailable?: number;
  maxAvailable?: number;
  dateType?: 'receipt' | 'expiry' | 'mfg';
  from?: string;
  to?: string;
  variantId?: string;
  batchId?: string;
  ownerType?: string;
  sort?: 'expiry' | 'available' | 'onHand' | 'received';
}

const STATUS_COL: Record<string, string> = {
  QC_HOLD: '"qcHold"',
  AVAILABLE: '"available"',
  RESERVED: '"reserved"',
  PICKED: '"picked"',
  PACKED: '"packed"',
  QUARANTINED: '"quarantined"',
  DAMAGED: '"damaged"',
  EXPIRED: '"expired"',
  RETURNED: '"returned"',
};

/** Read-only queries behind the W4 screens (D-57a Phase 2). Only stock tables are touched. */
export class StockReadRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── totals ──

  totals(scope: WarehouseScope, o: { warehouseId?: string; variantId?: string } = {}) {
    return withPrismaErrors(async () => {
      const rows = await this.db.$queryRaw<Totals[]>`
        SELECT ${SUM_COLS}, COALESCE(sum("nearExpiry"),0)::int AS "nearExpiry",
          COALESCE(sum("expiryUnknown"),0)::int AS "expiryUnknown"
        FROM "warehouse_stock_summary" WHERE true ${inScope('"warehouseId"', scope, o.warehouseId)}
        ${o.variantId === undefined ? Prisma.empty : Prisma.sql`AND "variantId" = ${o.variantId}::uuid`}`;
      return rows[0] ?? EMPTY;
    });
  }

  /** Totals of one batch (positions; optionally one warehouse). */
  batchTotals(batchId: string, scope: WarehouseScope, warehouseId?: string) {
    return withPrismaErrors(async () => {
      const rows = await this.db.$queryRaw<Totals[]>`
        SELECT ${SUM_COLS}, 0 AS "nearExpiry", 0 AS "expiryUnknown"
        FROM "warehouse_stock_positions" WHERE "batchId" = ${batchId}::uuid
        ${inScope('"warehouseId"', scope, warehouseId)}`;
      return rows[0] ?? EMPTY;
    });
  }

  /** Per warehouse totals (overview table, product "Stock by warehouse", node distribution). */
  byWarehouse(scope: WarehouseScope, variantId?: string) {
    return this.db.$queryRaw<(Totals & { warehouseId: string })[]>`
      SELECT "warehouseId", ${SUM_COLS}, COALESCE(sum("nearExpiry"),0)::int AS "nearExpiry",
        COALESCE(sum("expiryUnknown"),0)::int AS "expiryUnknown"
      FROM "warehouse_stock_summary" WHERE true ${inScope('"warehouseId"', scope)}
      ${variantId === undefined ? Prisma.empty : Prisma.sql`AND "variantId" = ${variantId}::uuid`}
      GROUP BY "warehouseId" ORDER BY sum(${Prisma.raw(PHYS)}) DESC`;
  }

  /** Physical / available / reserved by root category (landing, ATP tabs, matrix). */
  byCategory(scope: WarehouseScope, warehouseId?: string) {
    return this.db.$queryRaw<
      {
        rootCategoryId: string | null;
        warehouseId: string;
        skus: number;
        physical: number;
        available: number;
        reserved: number;
      }[]
    >`
      SELECT v."rootCategoryId", s."warehouseId", count(*)::int AS skus,
        sum(${Prisma.raw(phys('s'))})::int AS physical,
        sum(s."available")::int AS available,
        sum(s."reserved" + s."picked" + s."packed")::int AS reserved
      FROM "warehouse_stock_summary" s
      JOIN "warehouse_variant_projection" v ON v."variantId" = s."variantId"
      WHERE true ${inScope('s."warehouseId"', scope, warehouseId)}
      GROUP BY v."rootCategoryId", s."warehouseId"`;
  }

  /** Bins holding stock of each root category (location text "Racks B01–B08 Dry Zone"). */
  categoryBins(scope: WarehouseScope, warehouseId?: string) {
    return this.db.$queryRaw<{ rootCategoryId: string | null; binId: string; qty: number }[]>`
      SELECT v."rootCategoryId", p."binId", sum(${Prisma.raw(phys('p'))})::int AS qty
      FROM "warehouse_stock_positions" p
      JOIN "warehouse_variant_projection" v ON v."variantId" = p."variantId"
      WHERE p."binId" IS NOT NULL ${inScope('p."warehouseId"', scope, warehouseId)}
      GROUP BY v."rootCategoryId", p."binId" HAVING sum(${Prisma.raw(phys('p'))}) > 0`;
  }

  /** Most issued SKU in the last `days` (landing "Top Mover"). */
  async topMover(scope: WarehouseScope, days: number, warehouseId?: string) {
    const rows = await this.db.$queryRaw<{ variantId: string; units: number }[]>`
      SELECT "variantId", sum("qty")::int AS units FROM "warehouse_stock_movements"
      WHERE "type" = 'ISSUE' AND "createdAt" > now() - make_interval(days => ${days}::int)
      ${inScope('"warehouseId"', scope, warehouseId)}
      GROUP BY "variantId" ORDER BY units DESC LIMIT 1`;
    return rows[0] ?? null;
  }

  // ── product list (one row per SKU) ──

  products(
    scope: WarehouseScope,
    f: {
      q?: string;
      categoryId?: string;
      brandId?: string;
      vendorId?: string;
      stockState?: string;
      warehouseId?: string;
      sort?: string;
    },
    page: { limit: number; offset: number | null; after: readonly unknown[] | null },
  ) {
    const sortCol =
      f.sort === 'available' ? 'g."available"' : f.sort === 'onHand' ? 'g."physical"' : 'g."name"';
    const desc = f.sort === 'available' || f.sort === 'onHand';
    return this.db.$queryRaw<
      {
        variantId: string;
        sku: string;
        name: string;
        brandName: string | null;
        brandId: string;
        rootCategoryId: string | null;
        packLabel: string;
        imageUrl: string | null;
        physical: number;
        available: number;
        reserved: number;
        qcHold: number;
        blocked: number;
        reorderLevel: number;
        targetStock: number;
        warehouses: number;
      }[]
    >`
      SELECT * FROM (
        SELECT v."variantId", v."sku", v."name", v."brandName", v."brandId", v."rootCategoryId",
          v."packLabel", v."imageUrl",
          sum(${Prisma.raw(phys('s'))})::int AS physical,
          sum(s."available")::int AS available,
          sum(s."reserved" + s."picked" + s."packed")::int AS reserved,
          sum(s."qcHold")::int AS "qcHold",
          sum(s."damaged" + s."quarantined" + s."expired")::int AS blocked,
          COALESCE(sum(t."reorderLevel"),0)::int AS "reorderLevel",
          COALESCE(sum(t."targetStock"),0)::int AS "targetStock",
          count(DISTINCT s."warehouseId")::int AS warehouses
        FROM "warehouse_stock_summary" s
        JOIN "warehouse_variant_projection" v ON v."variantId" = s."variantId"
        LEFT JOIN "warehouse_stock_thresholds" t
          ON t."warehouseId" = s."warehouseId" AND t."variantId" = s."variantId"
        WHERE true ${inScope('s."warehouseId"', scope, f.warehouseId)}
        ${f.q === undefined ? Prisma.empty : Prisma.sql`AND v."searchText" ILIKE ${`%${f.q.toLowerCase()}%`}`}
        ${f.categoryId === undefined ? Prisma.empty : Prisma.sql`AND ${f.categoryId}::uuid = ANY(v."categoryPath")`}
        ${f.brandId === undefined ? Prisma.empty : Prisma.sql`AND v."brandId" = ${f.brandId}::uuid`}
        ${f.vendorId === undefined ? Prisma.empty : Prisma.sql`AND EXISTS (SELECT 1 FROM "warehouse_vendor_variants" vv WHERE vv."variantId" = v."variantId" AND vv."vendorId" = ${f.vendorId}::uuid)`}
        GROUP BY v."variantId"
      ) g
      WHERE true
      ${f.stockState === 'out' ? Prisma.sql`AND g."available" = 0` : Prisma.empty}
      ${f.stockState === 'low' ? Prisma.sql`AND g."available" > 0 AND g."available" <= g."reorderLevel"` : Prisma.empty}
      ${f.stockState === 'ok' ? Prisma.sql`AND g."available" > g."reorderLevel"` : Prisma.empty}
      ${after(`${sortCol}, g."variantId"`, page.after, desc)}
      ORDER BY ${Prisma.raw(sortCol)} ${Prisma.raw(desc ? 'DESC' : 'ASC')}, g."variantId" ${Prisma.raw(desc ? 'DESC' : 'ASC')}
      LIMIT ${page.limit + 1} ${page.offset === null ? Prisma.empty : Prisma.sql`OFFSET ${page.offset}`}`;
  }

  // ── stock records (All Stock: warehouse × batch × bin × owner) ──

  private recordWhere(scope: WarehouseScope, f: RecordFilter, warehouseId?: string): Prisma.Sql {
    const today = Prisma.sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`;
    const dateCol =
      f.dateType === 'expiry'
        ? 'p."expiryDate"'
        : f.dateType === 'mfg'
          ? 'b."mfgDate"'
          : 'p."receivedAt"';
    return Prisma.sql`
      WHERE ${Prisma.raw(phys('p'))} > 0
      ${inScope('p."warehouseId"', scope, warehouseId)}
      ${f.variantId === undefined ? Prisma.empty : Prisma.sql`AND p."variantId" = ${f.variantId}::uuid`}
      ${f.batchId === undefined ? Prisma.empty : Prisma.sql`AND p."batchId" = ${f.batchId}::uuid`}
      ${f.ownerType === undefined ? Prisma.empty : Prisma.sql`AND p."ownerType" = ${f.ownerType}::"WmsOwnerType"`}
      ${f.q === undefined ? Prisma.empty : Prisma.sql`AND (v."searchText" ILIKE ${`%${f.q.toLowerCase()}%`} OR lower(b."batchNo") LIKE ${`%${f.q.toLowerCase()}%`} ${f.binIds !== undefined && f.binIds.length > 0 ? Prisma.sql`OR p."binId" = ANY(${[...f.binIds]}::uuid[])` : Prisma.empty})`}
      ${f.q === undefined && f.binIds !== undefined ? Prisma.sql`AND p."binId" = ANY(${[...f.binIds]}::uuid[])` : Prisma.empty}
      ${f.brandId === undefined ? Prisma.empty : Prisma.sql`AND v."brandId" = ${f.brandId}::uuid`}
      ${f.categoryId === undefined ? Prisma.empty : Prisma.sql`AND ${f.categoryId}::uuid = ANY(v."categoryPath")`}
      ${f.vendorId === undefined ? Prisma.empty : Prisma.sql`AND (p."vendorId" = ${f.vendorId}::uuid OR b."vendorId" = ${f.vendorId}::uuid)`}
      ${f.batchNo === undefined ? Prisma.empty : Prisma.sql`AND b."batchNo" ILIKE ${`%${f.batchNo}%`}`}
      ${f.status === undefined || STATUS_COL[f.status] === undefined ? Prisma.empty : Prisma.sql`AND p.${Prisma.raw(STATUS_COL[f.status] ?? '')} > 0`}
      ${f.minAvailable === undefined ? Prisma.empty : Prisma.sql`AND p."available" >= ${f.minAvailable}`}
      ${f.maxAvailable === undefined ? Prisma.empty : Prisma.sql`AND p."available" <= ${f.maxAvailable}`}
      ${f.expiry === 'expired' ? Prisma.sql`AND p."expiryDate" < ${today}` : Prisma.empty}
      ${f.expiry === '30d' ? Prisma.sql`AND p."expiryDate" >= ${today} AND p."expiryDate" < ${today} + 30` : Prisma.empty}
      ${f.expiry === '90d' ? Prisma.sql`AND p."expiryDate" >= ${today} AND p."expiryDate" < ${today} + 90` : Prisma.empty}
      ${f.expiry === 'later' ? Prisma.sql`AND p."expiryDate" >= ${today} + 90` : Prisma.empty}
      ${f.expiry === 'unknown' ? Prisma.sql`AND p."expiryDate" IS NULL` : Prisma.empty}
      ${f.from === undefined ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(dateCol)} >= ${f.from}::date`}
      ${f.to === undefined ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(dateCol)} < ${f.to}::date + 1`}`;
  }

  records(
    scope: WarehouseScope,
    f: RecordFilter & { warehouseId?: string },
    page: { limit: number; offset: number | null; after: readonly unknown[] | null },
  ) {
    const sort =
      f.sort === 'available'
        ? { col: 'p."available"', desc: true }
        : f.sort === 'onHand'
          ? { col: phys('p'), desc: true }
          : f.sort === 'received'
            ? { col: 'p."receivedAt"', desc: true }
            : { col: `COALESCE(p."expiryDate", '9999-12-31'::date)`, desc: false };
    return withPrismaErrors(
      () =>
        this.db.$queryRaw<RecordRow[]>`
        SELECT p."id" AS "positionId", p."warehouseId", p."variantId", p."batchId", p."binId",
          p."ownerType", p."vendorId", p."expiryDate", p."receivedAt", p."reviewFields",
          ${Prisma.raw(phys('p'))}::int AS "onHand",
          p."available", (p."reserved" + p."picked" + p."packed")::int AS reserved,
          p."qcHold", p."quarantined", p."damaged", p."expired", p."returned",
          b."batchNo", b."mfgDate", b."vendorId" AS "batchVendorId", b."isOpening",
          v."sku", v."name", v."brandName", v."packLabel", v."imageUrl",
          ${Prisma.raw(sort.col)} AS "sortKey"
        FROM "warehouse_stock_positions" p
        JOIN "warehouse_batches" b ON b."id" = p."batchId"
        JOIN "warehouse_variant_projection" v ON v."variantId" = p."variantId"
        ${this.recordWhere(scope, f, f.warehouseId)}
        ${after(`${sort.col}, p."id"`, page.after, sort.desc)}
        ORDER BY ${Prisma.raw(sort.col)} ${Prisma.raw(sort.desc ? 'DESC' : 'ASC')}, p."id" ${Prisma.raw(sort.desc ? 'DESC' : 'ASC')}
        LIMIT ${page.limit + 1} ${page.offset === null ? Prisma.empty : Prisma.sql`OFFSET ${page.offset}`}`,
    );
  }

  async recordsCount(scope: WarehouseScope, f: RecordFilter & { warehouseId?: string }) {
    const rows = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM "warehouse_stock_positions" p
        JOIN "warehouse_batches" b ON b."id" = p."batchId"
        JOIN "warehouse_variant_projection" v ON v."variantId" = p."variantId"
        ${this.recordWhere(scope, f, f.warehouseId)} LIMIT 10001) x`;
    return rows[0]?.n ?? 0;
  }

  /** Grouped by (warehouse, batch) for product "Batches" and batch headers. */
  batchesOfVariant(variantId: string, scope: WarehouseScope, warehouseId?: string) {
    return this.db.$queryRaw<
      {
        batchId: string;
        batchNo: string;
        warehouseId: string;
        expiryDate: Date | null;
        mfgDate: Date | null;
        physical: number;
        available: number;
        reserved: number;
        binIds: (string | null)[];
        isOpening: boolean;
      }[]
    >`
      SELECT p."batchId", b."batchNo", p."warehouseId", b."expiryDate", b."mfgDate", b."isOpening",
        sum(${Prisma.raw(phys('p'))})::int AS physical,
        sum(p."available")::int AS available,
        sum(p."reserved" + p."picked" + p."packed")::int AS reserved,
        array_agg(p."binId" ORDER BY p."available" DESC) AS "binIds"
      FROM "warehouse_stock_positions" p JOIN "warehouse_batches" b ON b."id" = p."batchId"
      WHERE p."variantId" = ${variantId}::uuid ${inScope('p."warehouseId"', scope, warehouseId)}
      GROUP BY p."batchId", b."batchNo", p."warehouseId", b."expiryDate", b."mfgDate", b."isOpening"
      HAVING sum(${Prisma.raw(phys('p'))}) > 0
      ORDER BY b."expiryDate" ASC NULLS LAST, b."batchNo"`;
  }

  positionsOfBatch(batchId: string, scope: WarehouseScope, warehouseId?: string) {
    return withPrismaErrors(() =>
      this.db.wmsStockPosition.findMany({
        where: {
          batchId,
          ...(warehouseId !== undefined
            ? { warehouseId }
            : scope === 'ALL'
              ? {}
              : { warehouseId: { in: [...scope] } }),
        },
        orderBy: { available: 'desc' },
      }),
    );
  }

  receiptsOfBatch(batchId: string, warehouseId?: string) {
    return this.db.$queryRaw<
      {
        receiptId: string;
        cnNo: string;
        warehouseId: string;
        receivedAt: Date;
        qty: number;
        sourceType: string;
      }[]
    >`
      SELECT r."id" AS "receiptId", r."cnNo", r."warehouseId", r."receivedAt", sum(l."qty")::int AS qty, r."sourceType"::text
      FROM "warehouse_receipt_lines" l JOIN "warehouse_receipts" r ON r."id" = l."receiptId"
      WHERE l."batchId" = ${batchId}::uuid
      ${warehouseId === undefined ? Prisma.empty : Prisma.sql`AND r."warehouseId" = ${warehouseId}::uuid`}
      GROUP BY r."id" ORDER BY r."receivedAt" ASC`;
  }

  // ── units ──

  units(
    f: {
      batchId?: string;
      variantId?: string;
      warehouseId?: string;
      status?: string;
      binId?: string;
    },
    scope: WarehouseScope,
    page: { limit: number; afterSeq: readonly unknown[] | null },
  ) {
    return withPrismaErrors(
      () =>
        this.db.$queryRaw<
          {
            qrCode: string;
            batchId: string;
            variantId: string;
            warehouseId: string | null;
            binId: string | null;
            status: string;
            seq: number;
            ownerType: string;
            lastEventAt: Date;
            batchNo: string;
          }[]
        >`
        SELECT u."qrCode", u."batchId", u."variantId", u."warehouseId", u."binId", u."status"::text,
          u."seq", u."ownerType"::text, u."lastEventAt", b."batchNo"
        FROM "warehouse_stock_units" u JOIN "warehouse_batches" b ON b."id" = u."batchId"
        WHERE true
        ${f.batchId === undefined ? Prisma.empty : Prisma.sql`AND u."batchId" = ${f.batchId}::uuid`}
        ${f.variantId === undefined ? Prisma.empty : Prisma.sql`AND u."variantId" = ${f.variantId}::uuid`}
        ${f.status === undefined ? Prisma.empty : Prisma.sql`AND u."status" = ${f.status}::"WmsStockStatus"`}
        ${f.binId === undefined ? Prisma.empty : Prisma.sql`AND u."binId" = ${f.binId}::uuid`}
        ${inScope('u."warehouseId"', scope, f.warehouseId)}
        ${after('u."batchId", u."seq"', page.afterSeq)}
        ORDER BY u."batchId", u."seq" LIMIT ${page.limit + 1}`,
    );
  }

  unit(qrCode: string) {
    return withPrismaErrors(() => this.db.wmsStockUnit.findUnique({ where: { qrCode } }));
  }

  // ── movements ──

  movements(
    scope: WarehouseScope,
    f: {
      type?: string;
      types?: readonly string[];
      warehouseId?: string;
      variantId?: string;
      batchId?: string;
      refNo?: string;
      from?: string;
      to?: string;
    },
    page: { limit: number; offset: number | null; after: readonly unknown[] | null },
  ) {
    return withPrismaErrors(
      () =>
        this.db.$queryRaw<MovementRow[]>`
        SELECT m."id", m."createdAt", m."type"::text, m."fromStatus"::text AS "fromStatus",
          m."toStatus"::text AS "toStatus", m."qty", m."sellableDelta", m."damagedDelta",
          m."warehouseId", m."variantId", m."batchId", m."binId", m."ownerType"::text,
          m."refType", m."refId", m."refNo", m."reason", m."actorUserId",
          v."sku", v."name", b."batchNo"
        FROM "warehouse_stock_movements" m
        LEFT JOIN "warehouse_variant_projection" v ON v."variantId" = m."variantId"
        LEFT JOIN "warehouse_batches" b ON b."id" = m."batchId"
        WHERE true ${inScope('m."warehouseId"', scope, f.warehouseId)}
        ${f.type === undefined ? Prisma.empty : Prisma.sql`AND m."type" = ${f.type}::"WmsMovementType"`}
        ${f.types === undefined ? Prisma.empty : Prisma.sql`AND m."type"::text = ANY(${[...f.types]}::text[])`}
        ${f.variantId === undefined ? Prisma.empty : Prisma.sql`AND m."variantId" = ${f.variantId}::uuid`}
        ${f.batchId === undefined ? Prisma.empty : Prisma.sql`AND m."batchId" = ${f.batchId}::uuid`}
        ${f.refNo === undefined ? Prisma.empty : Prisma.sql`AND m."refNo" = ${f.refNo}`}
        ${f.from === undefined ? Prisma.empty : Prisma.sql`AND m."createdAt" >= ${f.from}::date`}
        ${f.to === undefined ? Prisma.empty : Prisma.sql`AND m."createdAt" < ${f.to}::date + 1`}
        ${after('m."createdAt", m."id"', page.after === null ? null : [new Date(String(page.after[0])), page.after[1]], true)}
        ORDER BY m."createdAt" DESC, m."id" DESC
        LIMIT ${page.limit + 1} ${page.offset === null ? Prisma.empty : Prisma.sql`OFFSET ${page.offset}`}`,
    );
  }

  movement(id: string) {
    return withPrismaErrors(() => this.db.wmsStockMovement.findUnique({ where: { id } }));
  }

  /** Units issued per month for one SKU at a warehouse (restock review). */
  issuedByMonth(warehouseId: string, variantId: string, months: number) {
    return this.db.$queryRaw<{ month: string; units: number }[]>`
      SELECT to_char(date_trunc('month', "createdAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month,
        sum("qty")::int AS units
      FROM "warehouse_stock_movements"
      WHERE "warehouseId" = ${warehouseId}::uuid AND "variantId" = ${variantId}::uuid AND "type" = 'ISSUE'
        AND "createdAt" > now() - make_interval(months => ${months}::int)
      GROUP BY 1 ORDER BY 1`;
  }

  // ── ownership ──

  ownershipTotals(scope: WarehouseScope, warehouseId?: string) {
    return this.db.$queryRaw<{ ownerType: string; physical: number; available: number }[]>`
      SELECT p."ownerType"::text, sum(${Prisma.raw(phys('p'))})::int AS physical,
        sum(p."available")::int AS available
      FROM "warehouse_stock_positions" p WHERE true ${inScope('p."warehouseId"', scope, warehouseId)}
      GROUP BY p."ownerType"`;
  }

  ownership(
    scope: WarehouseScope,
    f: { model?: string; vendorId?: string; q?: string; warehouseId?: string },
    page: { limit: number; offset: number | null; after: readonly unknown[] | null },
  ) {
    return this.db.$queryRaw<
      {
        variantId: string;
        name: string;
        sku: string;
        vendorId: string | null;
        warehouseId: string;
        ownerType: string;
        physical: number;
        available: number;
        topBatchId: string;
      }[]
    >`
      SELECT * FROM (
        SELECT p."variantId", v."name", v."sku", COALESCE(p."vendorId", b."vendorId") AS "vendorId",
          p."warehouseId", p."ownerType"::text AS "ownerType",
          sum(${Prisma.raw(phys('p'))})::int AS physical,
          sum(p."available")::int AS available,
          (array_agg(p."batchId" ORDER BY p."available" DESC))[1] AS "topBatchId"
        FROM "warehouse_stock_positions" p
        JOIN "warehouse_variant_projection" v ON v."variantId" = p."variantId"
        JOIN "warehouse_batches" b ON b."id" = p."batchId"
        WHERE true ${inScope('p."warehouseId"', scope, f.warehouseId)}
        ${f.model === undefined ? Prisma.empty : Prisma.sql`AND p."ownerType" = ${f.model}::"WmsOwnerType"`}
        ${f.vendorId === undefined ? Prisma.empty : Prisma.sql`AND (p."vendorId" = ${f.vendorId}::uuid OR b."vendorId" = ${f.vendorId}::uuid)`}
        ${f.q === undefined ? Prisma.empty : Prisma.sql`AND v."searchText" ILIKE ${`%${f.q.toLowerCase()}%`}`}
        GROUP BY p."variantId", v."name", v."sku", COALESCE(p."vendorId", b."vendorId"), p."warehouseId", p."ownerType"
        HAVING sum(${Prisma.raw(phys('p'))}) > 0
      ) g
      WHERE true ${after('g."name", g."warehouseId", g."ownerType", g."variantId"', page.after)}
      ORDER BY g."name", g."warehouseId", g."ownerType", g."variantId"
      LIMIT ${page.limit + 1} ${page.offset === null ? Prisma.empty : Prisma.sql`OFFSET ${page.offset}`}`;
  }

  // ── depletion alerts / restock plan ──

  /**
   * SKUs at or below the minimum (or out of sellable stock), with threshold, target and open
   * inbound (approved / in-transit restock lines not yet received).
   */
  alerts(
    scope: WarehouseScope,
    f: {
      type?: 'all' | 'low' | 'out' | 'plan';
      warehouseId?: string;
      q?: string;
      vendorId?: string;
      brandId?: string;
    },
    page: { limit: number; offset: number | null; after: readonly unknown[] | null },
  ) {
    return this.db.$queryRaw<AlertRow[]>`
      SELECT * FROM (
        SELECT s."warehouseId", s."variantId", v."sku", v."name", v."brandName", v."brandId",
          s."available", COALESCE(t."reorderLevel",0) AS "reorderLevel",
          COALESCE(t."targetStock",0) AS "targetStock", COALESCE(t."safetyStock",0) AS "safetyStock",
          COALESCE(ib.qty, 0)::int AS inbound,
          (SELECT vv."vendorId" FROM "warehouse_vendor_variants" vv
             WHERE vv."variantId" = s."variantId" ORDER BY vv."isPreferred" DESC LIMIT 1) AS "vendorId",
          GREATEST(
            CASE WHEN COALESCE(t."targetStock",0) > 0 THEN t."targetStock" ELSE COALESCE(t."reorderLevel",0) END
              - s."available" - COALESCE(ib.qty, 0), 0)::int AS suggested,
          CASE WHEN s."available" = 0 THEN 'OUT' WHEN s."available" <= COALESCE(t."reorderLevel",0) THEN 'LOW' ELSE 'OK' END AS state
        FROM "warehouse_stock_summary" s
        JOIN "warehouse_variant_projection" v ON v."variantId" = s."variantId"
        LEFT JOIN "warehouse_stock_thresholds" t ON t."warehouseId" = s."warehouseId" AND t."variantId" = s."variantId"
        LEFT JOIN LATERAL (
          SELECT sum(GREATEST(COALESCE(l."approvedQty", l."requestedQty") - l."receivedQty", 0))::int AS qty
          FROM "warehouse_restock_lines" l JOIN "warehouse_restock_requests" r ON r."id" = l."requestId"
          WHERE r."destWarehouseId" = s."warehouseId" AND l."variantId" = s."variantId"
            AND r."status" IN ('APPROVED','IN_TRANSIT','PARTIALLY_RECEIVED')
        ) ib ON true
        WHERE v."isActive" ${inScope('s."warehouseId"', scope, f.warehouseId)}
        ${f.q === undefined ? Prisma.empty : Prisma.sql`AND v."searchText" ILIKE ${`%${f.q.toLowerCase()}%`}`}
        ${f.brandId === undefined ? Prisma.empty : Prisma.sql`AND v."brandId" = ${f.brandId}::uuid`}
      ) a
      WHERE true
      ${f.type === 'low' ? Prisma.sql`AND a.state = 'LOW'` : Prisma.empty}
      ${f.type === 'out' ? Prisma.sql`AND a.state = 'OUT' AND (a."reorderLevel" > 0 OR a."targetStock" > 0)` : Prisma.empty}
      ${f.type === 'all' || f.type === undefined ? Prisma.sql`AND (a.state = 'LOW' OR (a.state = 'OUT' AND (a."reorderLevel" > 0 OR a."targetStock" > 0)))` : Prisma.empty}
      ${f.type === 'plan' ? Prisma.sql`AND a.suggested > 0` : Prisma.empty}
      ${f.vendorId === undefined ? Prisma.empty : Prisma.sql`AND a."vendorId" = ${f.vendorId}::uuid`}
      ${after('a."available", a."warehouseId", a."variantId"', page.after)}
      ORDER BY a."available", a."warehouseId", a."variantId"
      LIMIT ${page.limit + 1} ${page.offset === null ? Prisma.empty : Prisma.sql`OFFSET ${page.offset}`}`;
  }

  async alertCounts(scope: WarehouseScope, warehouseId?: string) {
    const rows = await this.db.$queryRaw<{ low: number; out: number; suggested: number }[]>`
      SELECT count(*) FILTER (WHERE s."available" > 0 AND s."available" <= t."reorderLevel")::int AS low,
        count(*) FILTER (WHERE s."available" = 0 AND (t."reorderLevel" > 0 OR t."targetStock" > 0))::int AS out,
        COALESCE(sum(GREATEST(CASE WHEN t."targetStock" > 0 THEN t."targetStock" ELSE t."reorderLevel" END - s."available", 0))
          FILTER (WHERE s."available" <= t."reorderLevel" OR s."available" = 0), 0)::int AS suggested
      FROM "warehouse_stock_summary" s
      JOIN "warehouse_stock_thresholds" t ON t."warehouseId" = s."warehouseId" AND t."variantId" = s."variantId"
      WHERE true ${inScope('s."warehouseId"', scope, warehouseId)}`;
    return rows[0] ?? { low: 0, out: 0, suggested: 0 };
  }

  /** Distinct batches with units in reserved / picked / packed (W4.05 "Reserved batches"). */
  async reservedBatchCount(scope: WarehouseScope, warehouseId?: string) {
    const rows = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT p."batchId")::int AS n FROM "warehouse_stock_positions" p
      WHERE (p."reserved" + p."picked" + p."packed") > 0 ${inScope('p."warehouseId"', scope, warehouseId)}`;
    return rows[0]?.n ?? 0;
  }

  // ── filter options ──

  brands(scope: WarehouseScope, q: string | undefined, limit: number) {
    return this.db.$queryRaw<{ id: string; name: string | null }[]>`
      SELECT DISTINCT v."brandId" AS id, v."brandName" AS name FROM "warehouse_variant_projection" v
      WHERE EXISTS (SELECT 1 FROM "warehouse_stock_summary" s WHERE s."variantId" = v."variantId" ${inScope('s."warehouseId"', scope)})
      ${q === undefined ? Prisma.empty : Prisma.sql`AND v."brandName" ILIKE ${`%${q}%`}`}
      ORDER BY 2 LIMIT ${limit}`;
  }

  categoriesInStock(scope: WarehouseScope) {
    return this.db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT unnest(v."categoryPath") AS id FROM "warehouse_variant_projection" v
      WHERE EXISTS (SELECT 1 FROM "warehouse_stock_summary" s WHERE s."variantId" = v."variantId" ${inScope('s."warehouseId"', scope)})`;
  }

  /**
   * Header search (D-56 portal `GET /search`): SKU, batch, unit QR, receipt (CN / RT), restock
   * request (RST) and transfer (TR) numbers, each capped at `limit` rows, scoped.
   */
  search(scope: WarehouseScope, q: string, limit: number) {
    const up = q.toUpperCase();
    const prefix = `${up}%`;
    return this.db.$queryRaw<
      { type: string; id: string; title: string; subtitle: string; warehouseId: string | null }[]
    >`
      (SELECT 'sku' AS type, v."variantId"::text AS id, v."name" AS title, v."sku" AS subtitle,
          NULL::text AS "warehouseId"
        FROM "warehouse_variant_projection" v
        WHERE v."isActive" AND (v."sku" ILIKE ${prefix} OR v."searchText" ILIKE ${`%${q.toLowerCase()}%`})
          AND EXISTS (SELECT 1 FROM "warehouse_stock_summary" s WHERE s."variantId" = v."variantId" ${inScope('s."warehouseId"', scope)})
        ORDER BY v."name" LIMIT ${limit})
      UNION ALL
      (SELECT 'batch', b."id"::text, b."batchNo", v."sku" || ' · ' || v."name",
          (array_agg(p."warehouseId"::text ORDER BY p."available" DESC))[1]
        FROM "warehouse_batches" b
        JOIN "warehouse_variant_projection" v ON v."variantId" = b."variantId"
        JOIN "warehouse_stock_positions" p ON p."batchId" = b."id"
        WHERE b."batchNo" LIKE ${prefix} ${inScope('p."warehouseId"', scope)}
        GROUP BY b."id", b."batchNo", v."sku", v."name" ORDER BY b."batchNo" LIMIT ${limit})
      UNION ALL
      (SELECT 'unit', u."qrCode", u."qrCode", u."status"::text, u."warehouseId"::text
        FROM "warehouse_stock_units" u
        WHERE u."qrCode" LIKE ${prefix} AND u."warehouseId" IS NOT NULL ${inScope('u."warehouseId"', scope)}
        ORDER BY u."qrCode" LIMIT ${limit})
      UNION ALL
      (SELECT 'receipt', r."id"::text, r."cnNo", r."sourceType"::text || ' · ' || to_char(r."receivedAt", 'DD Mon YYYY'),
          r."warehouseId"::text
        FROM "warehouse_receipts" r
        WHERE r."cnNo" LIKE ${prefix} ${inScope('r."warehouseId"', scope)}
        ORDER BY r."cnNo" DESC LIMIT ${limit})
      UNION ALL
      (SELECT 'restock', r."id"::text, r."requestNo", r."type"::text || ' · ' || r."status"::text,
          r."destWarehouseId"::text
        FROM "warehouse_restock_requests" r
        WHERE r."requestNo" LIKE ${prefix}
          ${scope === 'ALL' ? Prisma.empty : Prisma.sql`AND (r."destWarehouseId" = ANY(${[...scope]}::uuid[]) OR r."sourceWarehouseId" = ANY(${[...scope]}::uuid[]))`}
        ORDER BY r."requestNo" DESC LIMIT ${limit})
      UNION ALL
      (SELECT 'transfer', t."id"::text, t."trNo", t."status"::text, t."destWarehouseId"::text
        FROM "warehouse_transfers" t
        WHERE t."trNo" LIKE ${prefix}
          ${scope === 'ALL' ? Prisma.empty : Prisma.sql`AND (t."destWarehouseId" = ANY(${[...scope]}::uuid[]) OR t."sourceWarehouseId" = ANY(${[...scope]}::uuid[]))`}
        ORDER BY t."trNo" DESC LIMIT ${limit})`;
  }

  batchNos(scope: WarehouseScope, q: string | undefined, limit: number) {
    return this.db.$queryRaw<{ id: string; name: string }[]>`
      SELECT b."id", b."batchNo" AS name FROM "warehouse_batches" b
      WHERE EXISTS (SELECT 1 FROM "warehouse_stock_positions" p WHERE p."batchId" = b."id" ${inScope('p."warehouseId"', scope)})
      ${q === undefined ? Prisma.empty : Prisma.sql`AND lower(b."batchNo") LIKE ${`%${q.toLowerCase()}%`}`}
      ORDER BY b."batchNo" LIMIT ${limit}`;
  }
}

export interface RecordRow {
  positionId: string;
  warehouseId: string;
  variantId: string;
  batchId: string;
  binId: string | null;
  ownerType: string;
  vendorId: string | null;
  expiryDate: Date | null;
  receivedAt: Date;
  reviewFields: string[];
  onHand: number;
  available: number;
  reserved: number;
  qcHold: number;
  quarantined: number;
  damaged: number;
  expired: number;
  returned: number;
  batchNo: string;
  mfgDate: Date | null;
  batchVendorId: string | null;
  isOpening: boolean;
  sku: string;
  name: string;
  brandName: string | null;
  packLabel: string;
  imageUrl: string | null;
  sortKey: unknown;
}

export interface MovementRow {
  id: string;
  createdAt: Date;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  qty: number;
  sellableDelta: number;
  damagedDelta: number;
  warehouseId: string;
  variantId: string;
  batchId: string;
  binId: string | null;
  ownerType: string;
  refType: string;
  refId: string | null;
  refNo: string | null;
  reason: string | null;
  actorUserId: string | null;
  sku: string | null;
  name: string | null;
  batchNo: string | null;
}

export interface AlertRow {
  warehouseId: string;
  variantId: string;
  sku: string;
  name: string;
  brandName: string | null;
  brandId: string;
  available: number;
  reorderLevel: number;
  targetStock: number;
  safetyStock: number;
  inbound: number;
  vendorId: string | null;
  suggested: number;
  state: 'OUT' | 'LOW' | 'OK';
}
