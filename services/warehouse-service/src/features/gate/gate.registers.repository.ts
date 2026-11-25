import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

const ASN = {
  id: true,
  vendorAsnRef: true,
  warehouseId: true,
  vendorId: true,
  vendorName: true,
  restockRequestId: true,
  restockRequestNo: true,
  vehicleRegNo: true,
  etaAt: true,
  expectedUnits: true,
  declaredNetKg: true,
  dockBookingId: true,
  status: true,
  matchIssues: true,
  source: true,
  notes: true,
  createdBy: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  lines: { orderBy: { lineNo: 'asc' } },
} as const satisfies Prisma.WmsAsnSelect;
export type AsnRow = Prisma.WmsAsnGetPayload<{ select: typeof ASN }>;
export type VisitorRow = Prisma.WmsGateVisitorGetPayload<object>;
export type OutwardRow = Prisma.WmsGateOutwardMaterialGetPayload<object>;
export type CheckRow = Prisma.WmsGateSecurityCheckGetPayload<object>;

type Keyset = { at: Date; id: string } | null;
const desc = (after: Keyset, field: 'createdAt' | 'etaAt') =>
  after === null
    ? {}
    : {
        OR: [{ [field]: { lt: after.at } }, { [field]: after.at, id: { lt: after.id } }],
      };

/** Only place that touches the gate registers: ASNs, visitors, outward material, security checks. */
export class GateRegistersRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── ASN ──

  asn(id: string, tx?: Tx): Promise<AsnRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsAsn.findUnique({ where: { id }, select: ASN }),
    );
  }

  asnByRef(vendorId: string, vendorAsnRef: string): Promise<AsnRow | null> {
    return withPrismaErrors(() =>
      this.db.wmsAsn.findUnique({
        where: { vendorId_vendorAsnRef: { vendorId, vendorAsnRef } },
        select: ASN,
      }),
    );
  }

  async lockAsn(tx: Tx, id: string): Promise<AsnRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_asns" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.asn(id, tx);
  }

  createAsn(tx: Tx, data: Prisma.WmsAsnUncheckedCreateInput): Promise<AsnRow> {
    return withPrismaErrors(() => tx.wmsAsn.create({ data, select: ASN }));
  }

  updateAsn(tx: Tx, id: string, data: Prisma.WmsAsnUncheckedUpdateInput): Promise<AsnRow> {
    return withPrismaErrors(() =>
      tx.wmsAsn.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        select: ASN,
      }),
    );
  }

  async addConverted(tx: Tx, asnId: string, lineNo: number, qty: number): Promise<void> {
    await tx.wmsAsnLine.update({
      where: { asnId_lineNo: { asnId, lineNo } },
      data: { convertedQty: { increment: qty } },
    });
  }

  listAsns(
    q: { warehouseId: string; status?: string; q?: string; from?: Date; to?: Date },
    after: Keyset,
    limit: number,
  ): Promise<AsnRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsAsn.findMany({
        where: {
          warehouseId: q.warehouseId,
          ...(q.status === undefined ? {} : { status: q.status as never }),
          ...(q.q === undefined || q.q === ''
            ? {}
            : {
                OR: [
                  { vendorAsnRef: { contains: q.q, mode: 'insensitive' } },
                  { vendorName: { contains: q.q, mode: 'insensitive' } },
                  { restockRequestNo: { contains: q.q.toUpperCase() } },
                ],
              }),
          ...(q.from === undefined && q.to === undefined
            ? {}
            : {
                createdAt: {
                  ...(q.from === undefined ? {} : { gte: q.from }),
                  ...(q.to === undefined ? {} : { lt: q.to }),
                },
              }),
          ...desc(after, 'createdAt'),
        },
        select: ASN,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    );
  }

  async asnCounts(warehouseId: string, from: Date, to: Date) {
    const rows = await withPrismaErrors(() =>
      this.db.wmsAsn.groupBy({
        by: ['status'],
        where: { warehouseId, createdAt: { gte: from, lt: to } },
        _count: { _all: true },
      }),
    );
    return new Map(rows.map((r) => [r.status as string, r._count._all]));
  }

  /** Σ open (not yet converted) ASN qty per SKU against a PO, other ASNs only. */
  async openAsnQty(tx: Tx, restockRequestId: string, excludeAsnId: string | null) {
    const rows = await tx.$queryRaw<{ variantId: string; qty: bigint }[]>`
      SELECT l."variantId", SUM(l."qty" - l."convertedQty")::bigint AS qty
      FROM "warehouse_asn_lines" l
      JOIN "warehouse_asns" a ON a."id" = l."asnId"
      WHERE a."restockRequestId" = ${restockRequestId}::uuid
        AND a."status" IN ('MATCHED', 'PARTIALLY_CONVERTED')
        AND (${excludeAsnId}::uuid IS NULL OR a."id" <> ${excludeAsnId}::uuid)
      GROUP BY l."variantId"`;
    return new Map(rows.map((r) => [r.variantId, Number(r.qty)]));
  }

  // ── visitors ──

  visitor(id: string, tx?: Tx): Promise<VisitorRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).wmsGateVisitor.findUnique({ where: { id } }));
  }

  createVisitor(tx: Tx, data: Prisma.WmsGateVisitorUncheckedCreateInput): Promise<VisitorRow> {
    return withPrismaErrors(() => tx.wmsGateVisitor.create({ data }));
  }

  async updateVisitorIf(
    tx: Tx,
    id: string,
    from: readonly string[],
    data: Prisma.WmsGateVisitorUncheckedUpdateManyInput,
  ): Promise<VisitorRow | null> {
    const n = await tx.wmsGateVisitor.updateMany({
      where: { id, status: { in: from as never[] } },
      data: { ...data, version: { increment: 1 } },
    });
    return n.count === 0 ? null : this.visitor(id, tx);
  }

  listVisitors(
    q: { warehouseId: string; status?: string; from?: Date; to?: Date; q?: string },
    after: Keyset,
    limit: number,
  ): Promise<VisitorRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsGateVisitor.findMany({
        where: {
          warehouseId: q.warehouseId,
          ...(q.status === undefined ? {} : { status: q.status as never }),
          ...(q.q === undefined || q.q === ''
            ? {}
            : {
                OR: [
                  { name: { contains: q.q, mode: 'insensitive' } },
                  { company: { contains: q.q, mode: 'insensitive' } },
                  { visitorNo: { contains: q.q.toUpperCase() } },
                ],
              }),
          ...(q.from === undefined
            ? {}
            : { createdAt: { gte: q.from, ...(q.to === undefined ? {} : { lt: q.to }) } }),
          ...desc(after, 'createdAt'),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    );
  }

  async visitorCounts(warehouseId: string, from: Date, to: Date) {
    const [today, checkedOut, onSite] = await Promise.all([
      this.db.wmsGateVisitor.count({ where: { warehouseId, createdAt: { gte: from, lt: to } } }),
      this.db.wmsGateVisitor.count({
        where: { warehouseId, status: 'CHECKED_OUT', exitAt: { gte: from, lt: to } },
      }),
      this.db.wmsGateVisitor.count({ where: { warehouseId, status: 'ON_SITE' } }),
    ]);
    return { today, checkedOut, onSite };
  }

  visitorsDue(before: Date, limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsGateVisitor.findMany({
        where: { anonymizedAt: null, createdAt: { lt: before }, status: { not: 'ON_SITE' } },
        select: { id: true, name: true },
        take: limit,
      }),
    );
  }

  async anonymizeVisitor(tx: Tx, id: string, name: string): Promise<void> {
    await tx.wmsGateVisitor.update({
      where: { id },
      data: { name, mobile: null, anonymizedAt: new Date() },
    });
  }

  // ── outward material ──

  outward(id: string, tx?: Tx): Promise<OutwardRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsGateOutwardMaterial.findUnique({ where: { id } }),
    );
  }

  createOutward(
    tx: Tx,
    data: Prisma.WmsGateOutwardMaterialUncheckedCreateInput,
  ): Promise<OutwardRow> {
    return withPrismaErrors(() => tx.wmsGateOutwardMaterial.create({ data }));
  }

  async updateOutwardIf(
    tx: Tx,
    id: string,
    from: readonly string[],
    data: Prisma.WmsGateOutwardMaterialUncheckedUpdateManyInput,
  ): Promise<OutwardRow | null> {
    const n = await tx.wmsGateOutwardMaterial.updateMany({
      where: { id, status: { in: from as never[] } },
      data: { ...data, version: { increment: 1 } },
    });
    return n.count === 0 ? null : this.outward(id, tx);
  }

  listOutward(
    q: { warehouseId: string; status?: string; from?: Date; to?: Date },
    after: Keyset,
    limit: number,
  ): Promise<OutwardRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsGateOutwardMaterial.findMany({
        where: {
          warehouseId: q.warehouseId,
          ...(q.status === undefined ? {} : { status: q.status as never }),
          ...(q.from === undefined
            ? {}
            : { createdAt: { gte: q.from, ...(q.to === undefined ? {} : { lt: q.to }) } }),
          ...desc(after, 'createdAt'),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    );
  }

  outwardIssuedToday(warehouseId: string, from: Date, to: Date): Promise<number> {
    return withPrismaErrors(() =>
      this.db.wmsGateOutwardMaterial.count({
        where: {
          warehouseId,
          status: { in: ['AUTHORIZED', 'EXITED'] },
          createdAt: { gte: from, lt: to },
        },
      }),
    );
  }

  // ── security checks ──

  check(id: string, tx?: Tx): Promise<CheckRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsGateSecurityCheck.findUnique({ where: { id } }),
    );
  }

  createCheck(tx: Tx, data: Prisma.WmsGateSecurityCheckUncheckedCreateInput): Promise<CheckRow> {
    return withPrismaErrors(() => tx.wmsGateSecurityCheck.create({ data }));
  }

  async resolveCheckIf(
    tx: Tx,
    id: string,
    data: { resolvedBy: string; resolutionNote: string },
  ): Promise<CheckRow | null> {
    const n = await tx.wmsGateSecurityCheck.updateMany({
      where: { id, result: 'HOLD', resolvedAt: null },
      data: { ...data, resolvedAt: new Date() },
    });
    return n.count === 0 ? null : this.check(id, tx);
  }

  /** Open (unresolved) HOLD checks of a subject: blocks the outward pass / exit. */
  async openHolds(tx: Tx | null, subjectId: string): Promise<CheckRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsGateSecurityCheck.findMany({
        where: { subjectId, result: 'HOLD', resolvedAt: null },
      }),
    );
  }

  listChecks(
    q: { warehouseId: string; result?: string; open?: boolean },
    after: Keyset,
    limit: number,
  ): Promise<CheckRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsGateSecurityCheck.findMany({
        where: {
          warehouseId: q.warehouseId,
          ...(q.result === undefined ? {} : { result: q.result as never }),
          ...(q.open === true ? { resolvedAt: null, result: 'HOLD' } : {}),
          ...desc(after, 'createdAt'),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    );
  }

  openHoldCount(warehouseId: string): Promise<number> {
    return withPrismaErrors(() =>
      this.db.wmsGateSecurityCheck.count({
        where: { warehouseId, result: 'HOLD', resolvedAt: null },
      }),
    );
  }
}
