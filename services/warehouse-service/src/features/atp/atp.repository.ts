import { type Tx, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { WarehouseScope } from '../../middleware/access.js';

/** Shipments whose lines still claim stock (not dispatched, not cancelled). */
const OPEN = [
  'PENDING_RELEASE',
  'RELEASED',
  'ALLOCATED',
  'ASSIGNED',
  'PICKING',
  'PACKING',
  'QC',
  'READY_TO_DISPATCH',
];

export interface AtpFilter {
  warehouseId?: string;
  categoryId?: string;
  temperatureClass?: string;
  q?: string;
  health?: 'HEALTHY' | 'HIGH_DEMAND' | 'LOW_BUFFER' | 'THROTTLED' | 'OUT';
}

export interface AtpParams {
  healthyPct: number;
  lowPct: number;
  floorPct: number;
}

export interface AtpRow {
  warehouseId: string;
  variantId: string;
  sku: string | null;
  name: string | null;
  packLabel: string | null;
  imageUrl: string | null;
  rootCategoryId: string | null;
  temperatureClass: string;
  physical: number;
  available: number;
  allocated: number;
  onFloor: number;
  qcHold: number;
  blocked: number;
  returned: number;
  safety: number;
  reorderLevel: number;
  targetStock: number;
  demand: number;
  inbound: number;
  netAtp: number;
  projected: number;
  health: 'HEALTHY' | 'HIGH_DEMAND' | 'LOW_BUFFER';
  throttled: boolean;
}

export type AtpSort = 'netAtp' | 'physical' | 'projected' | 'demand' | 'name';
const SORT: Record<AtpSort, string> = {
  netAtp: 'c."netAtp"',
  physical: 'c."physical"',
  projected: 'c."projected"',
  demand: 'c."demand"',
  name: 'c."name"',
};

const scoped = (col: string, scope: WarehouseScope, warehouseId?: string): Prisma.Sql => {
  const c = Prisma.raw(col);
  if (warehouseId !== undefined) return Prisma.sql`AND ${c} = ${warehouseId}::uuid`;
  if (scope === 'ALL') return Prisma.empty;
  return Prisma.sql`AND ${c} = ANY(${[...scope]}::uuid[])`;
};

/**
 * ATP read model (D-57b W3.13): read-only reporting over the stock summary, thresholds, open
 * shipment demand and inbound transfers, plus the storefront sync table this feature owns.
 * netAtp = physical − open demand − safety − QC hold − blocked (quarantine/damaged/expired) −
 * returned (≥ 0); projected24h = netAtp + transfers arriving within 24 h.
 */
export class AtpRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  private base(scope: WarehouseScope, f: AtpFilter, p: AtpParams): Prisma.Sql {
    const goal = Prisma.raw(
      `(CASE WHEN b."targetStock" > 0 THEN b."targetStock" ELSE b."reorderLevel" END)`,
    );
    return Prisma.sql`
      WITH d AS (
        SELECT x."warehouseId", x."variantId", sum(x.q)::int AS demand FROM (
          SELECT s."warehouseId", l."variantId",
            GREATEST(l."qty" - l."cancelledQty" - l."dispatchedQty", 0) AS q
          FROM "warehouse_shipment_lines" l JOIN "warehouse_shipments" s ON s."id" = l."shipmentId"
          WHERE s."status"::text = ANY(${OPEN}) ${scoped('s."warehouseId"', scope, f.warehouseId)}
          UNION ALL
          -- Open backorders still claim stock at their warehouse (W3.14).
          SELECT bo."warehouseId", bo."variantId", bo."qty" AS q FROM "warehouse_backorders" bo
          WHERE bo."status"::text = 'OPEN' AND bo."warehouseId" IS NOT NULL
            ${scoped('bo."warehouseId"', scope, f.warehouseId)}
        ) x GROUP BY 1, 2
      ), t AS (
        SELECT tr."destWarehouseId" AS "warehouseId", tl."variantId",
          sum(GREATEST(tl."qty" - tl."receivedQty", 0))::int AS inbound
        FROM "warehouse_transfer_lines" tl JOIN "warehouse_transfers" tr ON tr."id" = tl."transferId"
        WHERE tr."status"::text IN ('IN_TRANSIT', 'PARTIALLY_RECEIVED')
          AND (tr."etaAt" IS NULL OR tr."etaAt" <= now() + interval '24 hours')
          ${scoped('tr."destWarehouseId"', scope, f.warehouseId)}
        GROUP BY 1, 2
      ), a AS (
        SELECT s."warehouseId", s."variantId", v."sku", v."name", v."packLabel", v."imageUrl",
          v."rootCategoryId", v."temperatureClass",
          (s."qcHold" + s."available" + s."reserved" + s."picked" + s."packed" + s."quarantined"
            + s."damaged" + s."expired" + s."returned")::int AS physical,
          s."available"::int AS available,
          (s."reserved" + s."picked" + s."packed")::int AS allocated,
          (s."picked" + s."packed")::int AS "onFloor",
          s."qcHold"::int AS "qcHold",
          (s."quarantined" + s."damaged" + s."expired")::int AS blocked,
          s."returned"::int AS returned,
          COALESCE(th."safetyStock", 0)::int AS safety,
          COALESCE(th."reorderLevel", 0)::int AS "reorderLevel",
          COALESCE(th."targetStock", 0)::int AS "targetStock",
          COALESCE(d.demand, 0)::int AS demand,
          COALESCE(t.inbound, 0)::int AS inbound
        FROM "warehouse_stock_summary" s
        JOIN "warehouse_variant_projection" v ON v."variantId" = s."variantId"
        LEFT JOIN "warehouse_stock_thresholds" th
          ON th."warehouseId" = s."warehouseId" AND th."variantId" = s."variantId"
        LEFT JOIN d ON d."warehouseId" = s."warehouseId" AND d."variantId" = s."variantId"
        LEFT JOIN t ON t."warehouseId" = s."warehouseId" AND t."variantId" = s."variantId"
        WHERE true ${scoped('s."warehouseId"', scope, f.warehouseId)}
        ${f.categoryId === undefined ? Prisma.empty : Prisma.sql`AND ${f.categoryId}::uuid = ANY(v."categoryPath")`}
        ${f.temperatureClass === undefined ? Prisma.empty : Prisma.sql`AND v."temperatureClass" = ${f.temperatureClass}`}
        ${f.q === undefined ? Prisma.empty : Prisma.sql`AND v."searchText" ILIKE ${`%${f.q.toLowerCase()}%`}`}
      ), b AS (
        SELECT a.*, GREATEST(a.physical - a.demand - a.safety - a."qcHold" - a.blocked - a.returned, 0)::int AS "netAtp"
        FROM a
      ), c AS (
        SELECT b.*, (b."netAtp" + b.inbound)::int AS projected,
          CASE
            WHEN ${goal} = 0 THEN CASE WHEN b."netAtp" > 0 THEN 'HEALTHY' ELSE 'LOW_BUFFER' END
            WHEN b."netAtp" * 100 > ${p.healthyPct} * ${goal} THEN 'HEALTHY'
            WHEN b."netAtp" * 100 >= ${p.lowPct} * ${goal} THEN 'HIGH_DEMAND'
            ELSE 'LOW_BUFFER'
          END AS health,
          (${p.floorPct} > 0 AND b."netAtp" > 0
            AND b."netAtp" <= ceil(b."reorderLevel" * ${p.floorPct} / 100.0)) AS throttled
        FROM b
      )`;
  }

  private healthWhere(f: AtpFilter): Prisma.Sql {
    if (f.health === undefined) return Prisma.empty;
    if (f.health === 'THROTTLED') return Prisma.sql`AND c.throttled`;
    if (f.health === 'OUT') return Prisma.sql`AND c."netAtp" = 0`;
    return Prisma.sql`AND c.health = ${f.health}`;
  }

  rows(
    scope: WarehouseScope,
    f: AtpFilter,
    p: AtpParams,
    sort: AtpSort,
    desc: boolean,
    page: { limit: number; offset: number | null; after: readonly unknown[] | null },
  ): Promise<AtpRow[]> {
    const col = SORT[sort];
    const cmp = desc ? '<' : '>';
    return withPrismaErrors(
      () => this.db.$queryRaw<AtpRow[]>`${this.base(scope, f, p)}
      SELECT * FROM c WHERE (c.physical > 0 OR c.demand > 0) ${this.healthWhere(f)}
      ${
        page.after === null
          ? Prisma.empty
          : Prisma.sql`AND (${Prisma.raw(col)}, c."warehouseId", c."variantId") ${Prisma.raw(cmp)} (${Prisma.join(page.after.map((v) => Prisma.sql`${v}`))})`
      }
      ORDER BY ${Prisma.raw(col)} ${Prisma.raw(desc ? 'DESC' : 'ASC')}, c."warehouseId" ${Prisma.raw(desc ? 'DESC' : 'ASC')}, c."variantId" ${Prisma.raw(desc ? 'DESC' : 'ASC')}
      LIMIT ${page.limit + 1} ${page.offset === null ? Prisma.empty : Prisma.sql`OFFSET ${page.offset}`}`,
    );
  }

  async count(scope: WarehouseScope, f: AtpFilter, p: AtpParams): Promise<number> {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`${this.base(scope, f, p)}
      SELECT count(*)::int AS n FROM (SELECT 1 FROM c WHERE (c.physical > 0 OR c.demand > 0) ${this.healthWhere(f)} LIMIT 10001) x`;
    return r?.n ?? 0;
  }

  async totals(scope: WarehouseScope, f: AtpFilter, p: AtpParams) {
    const [r] = await this.db.$queryRaw<
      {
        skus: number;
        physical: number;
        available: number;
        allocated: number;
        onFloor: number;
        qcHold: number;
        blocked: number;
        returned: number;
        safety: number;
        demand: number;
        inbound: number;
        netAtp: number;
        projected: number;
        healthy: number;
        highDemand: number;
        lowBuffer: number;
        throttled: number;
        out: number;
      }[]
    >`${this.base(scope, f, p)}
      SELECT count(DISTINCT c."variantId")::int AS skus,
        COALESCE(sum(c.physical),0)::int AS physical, COALESCE(sum(c.available),0)::int AS available,
        COALESCE(sum(c.allocated),0)::int AS allocated, COALESCE(sum(c."onFloor"),0)::int AS "onFloor",
        COALESCE(sum(c."qcHold"),0)::int AS "qcHold", COALESCE(sum(c.blocked),0)::int AS blocked,
        COALESCE(sum(c.returned),0)::int AS returned, COALESCE(sum(c.safety),0)::int AS safety,
        COALESCE(sum(c.demand),0)::int AS demand, COALESCE(sum(c.inbound),0)::int AS inbound,
        COALESCE(sum(c."netAtp"),0)::int AS "netAtp", COALESCE(sum(c.projected),0)::int AS projected,
        count(*) FILTER (WHERE c.health = 'HEALTHY')::int AS healthy,
        count(*) FILTER (WHERE c.health = 'HIGH_DEMAND')::int AS "highDemand",
        count(*) FILTER (WHERE c.health = 'LOW_BUFFER')::int AS "lowBuffer",
        count(*) FILTER (WHERE c.throttled)::int AS throttled,
        count(*) FILTER (WHERE c."netAtp" = 0)::int AS out
      FROM c WHERE c.physical > 0 OR c.demand > 0`;
    return r;
  }

  /** Net / projected ATP per warehouse (node distribution). */
  nodeAtp(scope: WarehouseScope, p: AtpParams) {
    return this.db.$queryRaw<
      { warehouseId: string; netAtp: number; projected: number; demand: number }[]
    >`${this.base(scope, {}, p)}
      SELECT c."warehouseId"::text AS "warehouseId", sum(c."netAtp")::int AS "netAtp",
        sum(c.projected)::int AS projected, sum(c.demand)::int AS demand
      FROM c GROUP BY 1`;
  }

  /** Category tabs: SKUs with stock or demand per root category. */
  categories(scope: WarehouseScope, warehouseId?: string) {
    return this.db.$queryRaw<{ rootCategoryId: string | null; skus: number; physical: number }[]>`
      SELECT v."rootCategoryId"::text AS "rootCategoryId", count(DISTINCT s."variantId")::int AS skus,
        sum(s."qcHold" + s."available" + s."reserved" + s."picked" + s."packed" + s."quarantined"
          + s."damaged" + s."expired" + s."returned")::int AS physical
      FROM "warehouse_stock_summary" s
      JOIN "warehouse_variant_projection" v ON v."variantId" = s."variantId"
      WHERE (s."qcHold" + s."available" + s."reserved" + s."picked" + s."packed") > 0
        ${scoped('s."warehouseId"', scope, warehouseId)}
      GROUP BY 1 ORDER BY 3 DESC`;
  }

  /** First FEFO lot (AVAILABLE) per warehouse × SKU of a page, with its zone. */
  topLots(pairs: readonly { warehouseId: string; variantId: string }[]) {
    if (pairs.length === 0) return Promise.resolve([]);
    return this.db.$queryRaw<
      {
        warehouseId: string;
        variantId: string;
        batchNo: string;
        expiryDate: Date | null;
        zoneName: string | null;
        zoneTemp: string | null;
        binCode: string | null;
      }[]
    >`
      SELECT DISTINCT ON (p."warehouseId", p."variantId")
        p."warehouseId"::text AS "warehouseId", p."variantId"::text AS "variantId", b."batchNo",
        p."expiryDate", z."name" AS "zoneName", z."temperatureClass"::text AS "zoneTemp",
        bn."code" AS "binCode"
      FROM "warehouse_stock_positions" p
      JOIN "warehouse_batches" b ON b."id" = p."batchId"
      LEFT JOIN "warehouse_bins" bn ON bn."id" = p."binId"
      LEFT JOIN "warehouse_zones" z ON z."id" = bn."zoneId"
      WHERE p."available" > 0
        AND (p."warehouseId", p."variantId") IN (
          SELECT * FROM unnest(${pairs.map((x) => x.warehouseId)}::uuid[], ${pairs.map((x) => x.variantId)}::uuid[]))
      ORDER BY p."warehouseId", p."variantId", p."expiryDate" ASC NULLS LAST, p."id"`;
  }

  /** Node distribution: totals per warehouse + transfers on the way (all ETAs). */
  nodes(scope: WarehouseScope) {
    return this.db.$queryRaw<
      {
        warehouseId: string;
        physical: number;
        available: number;
        allocated: number;
        skus: number;
        inboundUnits: number;
        inboundTransfers: number;
        nextEtaAt: Date | null;
      }[]
    >`
      WITH s AS (
        SELECT "warehouseId",
          sum("qcHold" + "available" + "reserved" + "picked" + "packed" + "quarantined" + "damaged"
            + "expired" + "returned")::int AS physical,
          sum("available")::int AS available, sum("reserved" + "picked" + "packed")::int AS allocated,
          count(*) FILTER (WHERE "available" > 0)::int AS skus
        FROM "warehouse_stock_summary" WHERE true ${scoped('"warehouseId"', scope)}
        GROUP BY 1
      ), t AS (
        SELECT tr."destWarehouseId" AS "warehouseId",
          sum(GREATEST(tl."qty" - tl."receivedQty", 0))::int AS units,
          count(DISTINCT tr."id")::int AS transfers, min(tr."etaAt") AS eta
        FROM "warehouse_transfers" tr JOIN "warehouse_transfer_lines" tl ON tl."transferId" = tr."id"
        WHERE tr."status"::text IN ('IN_TRANSIT', 'PARTIALLY_RECEIVED')
          ${scoped('tr."destWarehouseId"', scope)}
        GROUP BY 1
      )
      SELECT COALESCE(s."warehouseId", t."warehouseId")::text AS "warehouseId",
        COALESCE(s.physical, 0) AS physical, COALESCE(s.available, 0) AS available,
        COALESCE(s.allocated, 0) AS allocated, COALESCE(s.skus, 0) AS skus,
        COALESCE(t.units, 0) AS "inboundUnits", COALESCE(t.transfers, 0) AS "inboundTransfers",
        t.eta AS "nextEtaAt"
      FROM s FULL JOIN t ON t."warehouseId" = s."warehouseId"`;
  }

  // ── storefront sync (inventory.availability_changed.v1) ──

  /** Keeps the newest sequence per variant (older / duplicate deliveries are no-ops). */
  async upsertStorefront(
    tx: Tx,
    r: { variantId: string; publishedQty: number; inStock: boolean; sequence: number; at: Date },
  ) {
    await tx.$executeRaw`
      INSERT INTO "warehouse_storefront_sync" ("variantId", "publishedQty", "inStock", "sequence", "publishedAt")
      VALUES (${r.variantId}::uuid, ${r.publishedQty}, ${r.inStock}, ${r.sequence}, ${r.at})
      ON CONFLICT ("variantId") DO UPDATE SET
        "publishedQty" = EXCLUDED."publishedQty", "inStock" = EXCLUDED."inStock",
        "sequence" = EXCLUDED."sequence", "publishedAt" = EXCLUDED."publishedAt"
      WHERE "warehouse_storefront_sync"."sequence" < EXCLUDED."sequence"`;
  }

  storefront(variantIds: readonly string[]) {
    if (variantIds.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsStorefrontSync.findMany({
        where: { variantId: { in: [...new Set(variantIds)] } },
      }),
    );
  }

  async storefrontStats() {
    const [r] = await this.db.$queryRaw<
      { variants: number; inStock: number; lastAt: Date | null }[]
    >`
      SELECT count(*)::int AS variants, count(*) FILTER (WHERE "inStock")::int AS "inStock",
        max("publishedAt") AS "lastAt" FROM "warehouse_storefront_sync"`;
    return r ?? { variants: 0, inStock: 0, lastAt: null };
  }
}
