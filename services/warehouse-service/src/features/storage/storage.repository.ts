import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import { num } from '../../middleware/http.js';

const ZONE = {
  id: true,
  warehouseId: true,
  code: true,
  name: true,
  temperatureClass: true,
  minTempC: true,
  maxTempC: true,
  isSecure: true,
  isFoodGrade: true,
  productCategoryIds: true,
  status: true,
  sortOrder: true,
  version: true,
} as const satisfies Prisma.WmsZoneSelect;

const RACK = {
  id: true,
  warehouseId: true,
  zoneId: true,
  code: true,
  maxWeightKg: true,
  volumeM3: true,
  status: true,
  version: true,
  zone: { select: { code: true } },
} as const satisfies Prisma.WmsRackSelect;

const BIN = {
  id: true,
  warehouseId: true,
  zoneId: true,
  rackId: true,
  code: true,
  maxWeightKg: true,
  volumeM3: true,
  usedWeightKg: true,
  usedVolumeM3: true,
  status: true,
  rack: { select: { code: true, zone: { select: { code: true, temperatureClass: true } } } },
} as const satisfies Prisma.WmsBinSelect;

export type ZoneRow = Prisma.WmsZoneGetPayload<{ select: typeof ZONE }>;
export type RackRow = Prisma.WmsRackGetPayload<{ select: typeof RACK }>;
export type BinRow = Prisma.WmsBinGetPayload<{ select: typeof BIN }>;
export type ZoneWrite = Prisma.WmsZoneUncheckedUpdateInput;
export type RackWrite = Prisma.WmsRackUncheckedUpdateInput;
export type BinWrite = Prisma.WmsBinUncheckedUpdateInput;

/** Only place that touches `warehouse_zones`, `warehouse_racks` and `warehouse_bins`. */
export class StorageRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── Zones ──

  zones(warehouseId: string): Promise<ZoneRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsZone.findMany({
        where: { warehouseId },
        select: ZONE,
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
    );
  }

  zone(warehouseId: string, id: string, tx?: Tx): Promise<ZoneRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsZone.findFirst({ where: { id, warehouseId }, select: ZONE }),
    );
  }

  /** Row lock on a zone (edits, racks added to it). */
  async lockZone(tx: Tx, warehouseId: string, id: string): Promise<ZoneRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_zones" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.zone(warehouseId, id, tx);
  }

  createZone(tx: Tx, data: Prisma.WmsZoneUncheckedCreateInput): Promise<ZoneRow> {
    return withPrismaErrors(() => tx.wmsZone.create({ data, select: ZONE }));
  }

  updateZone(tx: Tx, id: string, data: ZoneWrite): Promise<ZoneRow> {
    return withPrismaErrors(() =>
      tx.wmsZone.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        select: ZONE,
      }),
    );
  }

  async deleteZone(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsZone.delete({ where: { id } }));
  }

  /** Rack and bin counts per zone of one warehouse. */
  async zoneCounts(warehouseId: string): Promise<Map<string, { racks: number; bins: number }>> {
    const [racks, bins] = await withPrismaErrors(() =>
      Promise.all([
        this.db.wmsRack.groupBy({ by: ['zoneId'], where: { warehouseId }, _count: { _all: true } }),
        this.db.wmsBin.groupBy({ by: ['zoneId'], where: { warehouseId }, _count: { _all: true } }),
      ]),
    );
    const out = new Map<string, { racks: number; bins: number }>();
    for (const r of racks) out.set(r.zoneId, { racks: r._count._all, bins: 0 });
    for (const b of bins)
      out.set(b.zoneId, { racks: out.get(b.zoneId)?.racks ?? 0, bins: b._count._all });
    return out;
  }

  /** ACTIVE zones per warehouse (setup checklist). */
  async activeZoneCounts(warehouseIds: readonly string[], tx?: Tx): Promise<Map<string, number>> {
    if (warehouseIds.length === 0) return new Map();
    const rows = await withPrismaErrors(() =>
      (tx ?? this.db).wmsZone.groupBy({
        by: ['warehouseId'],
        where: { warehouseId: { in: [...warehouseIds] }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
    );
    return new Map(rows.map((r) => [r.warehouseId, r._count._all]));
  }

  // ── Racks ──

  racks(warehouseId: string, zoneId?: string): Promise<RackRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsRack.findMany({
        where: { warehouseId, ...(zoneId === undefined ? {} : { zoneId }) },
        select: RACK,
        orderBy: { code: 'asc' },
      }),
    );
  }

  rack(warehouseId: string, id: string, tx?: Tx): Promise<RackRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsRack.findFirst({ where: { id, warehouseId }, select: RACK }),
    );
  }

  /** Row lock on a rack: serialises its bins and limits (capacity sums stay correct). */
  async lockRack(tx: Tx, warehouseId: string, id: string): Promise<RackRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_racks" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.rack(warehouseId, id, tx);
  }

  createRack(tx: Tx, data: Prisma.WmsRackUncheckedCreateInput): Promise<RackRow> {
    return withPrismaErrors(() => tx.wmsRack.create({ data, select: RACK }));
  }

  updateRack(tx: Tx, id: string, data: RackWrite): Promise<RackRow> {
    return withPrismaErrors(() =>
      tx.wmsRack.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        select: RACK,
      }),
    );
  }

  async deleteRack(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsRack.delete({ where: { id } }));
  }

  async countRacks(tx: Tx, zoneId: string): Promise<number> {
    return withPrismaErrors(() => tx.wmsRack.count({ where: { zoneId } }));
  }

  /** Codes in use that start with `prefix` (auto-coding the next rack / bin). */
  async codesWithPrefix(
    tx: Tx,
    warehouseId: string,
    prefix: string,
    kind: 'rack' | 'bin',
  ): Promise<string[]> {
    const where = { warehouseId, code: { startsWith: prefix } };
    const rows = await withPrismaErrors(() =>
      kind === 'rack'
        ? tx.wmsRack.findMany({ where, select: { code: true } })
        : tx.wmsBin.findMany({ where, select: { code: true } }),
    );
    return rows.map((r) => r.code);
  }

  /** Limits already given to the rack's bins (sum of bin limits). */
  async allocated(rackIds: readonly string[], tx?: Tx) {
    if (rackIds.length === 0)
      return new Map<string, { weight: number; volume: number; bins: number }>();
    const rows = await withPrismaErrors(() =>
      (tx ?? this.db).wmsBin.groupBy({
        by: ['rackId'],
        where: { rackId: { in: [...rackIds] } },
        _sum: { maxWeightKg: true, volumeM3: true },
        _count: { _all: true },
      }),
    );
    return new Map(
      rows.map((r) => [
        r.rackId,
        { weight: num(r._sum.maxWeightKg), volume: num(r._sum.volumeM3), bins: r._count._all },
      ]),
    );
  }

  // ── Bins ──

  bins(
    warehouseId: string,
    filter: { rackId?: string; zoneId?: string; cursor?: string; limit: number },
    tx?: Tx,
  ): Promise<BinRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsBin.findMany({
        where: {
          warehouseId,
          ...(filter.rackId === undefined ? {} : { rackId: filter.rackId }),
          ...(filter.zoneId === undefined ? {} : { zoneId: filter.zoneId }),
          ...(filter.cursor === undefined ? {} : { code: { gt: filter.cursor } }),
        },
        select: BIN,
        orderBy: { code: 'asc' },
        take: filter.limit + 1,
      }),
    );
  }

  /** Bin → rack → zone codes / names (stock screens: "A-01-01", "Racks B01–B08 Dry Zone"). */
  binLocations(ids: readonly string[]) {
    return withPrismaErrors(() =>
      this.db.wmsBin.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: {
          id: true,
          code: true,
          warehouseId: true,
          zoneId: true,
          rack: {
            select: {
              code: true,
              zone: {
                select: {
                  code: true,
                  name: true,
                  temperatureClass: true,
                  isFoodGrade: true,
                  isSecure: true,
                },
              },
            },
          },
        },
      }),
    );
  }

  /** Bins whose code contains `q` in some warehouses (filter typeahead). */
  binsByCode(warehouseIds: readonly string[] | 'ALL', q: string, limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsBin.findMany({
        where: {
          ...(warehouseIds === 'ALL' ? {} : { warehouseId: { in: [...warehouseIds] } }),
          code: { contains: q.toUpperCase() },
        },
        select: { id: true, code: true, warehouseId: true },
        orderBy: { code: 'asc' },
        take: limit,
      }),
    );
  }

  binIdByCode(warehouseId: string, code: string) {
    return withPrismaErrors(() =>
      this.db.wmsBin.findUnique({
        where: { warehouseId_code: { warehouseId, code: code.toUpperCase() } },
        select: { id: true },
      }),
    );
  }

  /** Bin facts for other features (stock positions, put-away): id → code, status, warehouse. */
  binFacts(ids: readonly string[], tx?: Tx) {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsBin.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: {
          id: true,
          warehouseId: true,
          zoneId: true,
          rackId: true,
          code: true,
          status: true,
        },
      }),
    );
  }

  bin(warehouseId: string, id: string, tx?: Tx): Promise<BinRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsBin.findFirst({ where: { id, warehouseId }, select: BIN }),
    );
  }

  /** Which of `codes` are already bins of the warehouse. */
  async existingBinCodes(tx: Tx, warehouseId: string, codes: readonly string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    const rows = await withPrismaErrors(() =>
      tx.wmsBin.findMany({
        where: { warehouseId, code: { in: [...codes] } },
        select: { code: true },
      }),
    );
    return rows.map((r) => r.code);
  }

  async createBins(tx: Tx, rows: Prisma.WmsBinCreateManyInput[]): Promise<void> {
    if (rows.length === 0) return;
    await withPrismaErrors(() => tx.wmsBin.createMany({ data: rows }));
  }

  updateBin(tx: Tx, id: string, data: BinWrite): Promise<BinRow> {
    return withPrismaErrors(() => tx.wmsBin.update({ where: { id }, data, select: BIN }));
  }

  async deleteBin(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsBin.delete({ where: { id } }));
  }

  async countBins(tx: Tx, rackId: string): Promise<number> {
    return withPrismaErrors(() => tx.wmsBin.count({ where: { rackId } }));
  }

  /** zoneId of bins follows the rack when a rack moves zone (not offered now; kept consistent). */
  async layout(warehouseId: string) {
    return withPrismaErrors(() =>
      this.db.wmsZone.findMany({
        where: { warehouseId },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          temperatureClass: true,
          isFoodGrade: true,
          status: true,
          racks: {
            orderBy: { code: 'asc' },
            select: {
              id: true,
              code: true,
              status: true,
              bins: { orderBy: { code: 'asc' }, select: { id: true, code: true, status: true } },
            },
          },
        },
      }),
    );
  }

  /** Zone codes and names of one warehouse (other features: rules, search). */
  zoneIndex(warehouseId: string) {
    return withPrismaErrors(() =>
      this.db.wmsZone.findMany({
        where: { warehouseId },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          temperatureClass: true,
          isFoodGrade: true,
          productCategoryIds: true,
        },
      }),
    );
  }

  /** Header search: bins / racks / zones by code. */
  async searchCodes(warehouseIds: readonly string[] | 'ALL', q: string, limit: number) {
    const where = {
      ...(warehouseIds === 'ALL' ? {} : { warehouseId: { in: [...warehouseIds] } }),
      code: { contains: q.toUpperCase() },
    };
    const [zones, racks, bins] = await withPrismaErrors(() =>
      Promise.all([
        this.db.wmsZone.findMany({
          where,
          select: { id: true, code: true, name: true, warehouseId: true },
          take: limit,
        }),
        this.db.wmsRack.findMany({
          where,
          select: { id: true, code: true, warehouseId: true },
          take: limit,
        }),
        this.db.wmsBin.findMany({
          where,
          select: { id: true, code: true, warehouseId: true },
          take: limit,
        }),
      ]),
    );
    return { zones, racks, bins };
  }
}
