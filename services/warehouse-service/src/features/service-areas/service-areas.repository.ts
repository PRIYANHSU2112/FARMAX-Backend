import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { AreaKind, AreaPriority, AreaRecord } from './service-areas.types.js';

const AREA = {
  id: true,
  warehouseId: true,
  kind: true,
  stateCode: true,
  district: true,
  priority: true,
  pinCount: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Only place that touches `warehouse_service_areas` and `warehouse_service_area_pins`. */
export class ServiceAreasRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Areas of a warehouse with their first / last PIN (one query each, no N+1). */
  async list(
    warehouseId: string,
  ): Promise<{ areas: AreaRecord[]; bounds: Map<string, { min: string; max: string }> }> {
    const [areas, bounds] = await withPrismaErrors(() =>
      Promise.all([
        this.db.wmsServiceArea.findMany({
          where: { warehouseId },
          select: AREA,
          orderBy: [{ kind: 'asc' }, { district: 'asc' }],
        }),
        this.db.wmsServiceAreaPin.groupBy({
          by: ['areaId'],
          where: { warehouseId },
          _min: { pinCode: true },
          _max: { pinCode: true },
        }),
      ]),
    );
    return {
      areas,
      bounds: new Map(
        bounds.map((b) => [b.areaId, { min: b._min.pinCode ?? '', max: b._max.pinCode ?? '' }]),
      ),
    };
  }

  find(warehouseId: string, areaId: string, tx?: Tx): Promise<AreaRecord | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsServiceArea.findFirst({
        where: { id: areaId, warehouseId },
        select: AREA,
      }),
    );
  }

  findMany(warehouseId: string, ids: readonly string[], tx: Tx): Promise<AreaRecord[]> {
    return withPrismaErrors(() =>
      tx.wmsServiceArea.findMany({ where: { id: { in: [...ids] }, warehouseId }, select: AREA }),
    );
  }

  /** The DISTRICT area of (state, district), case-insensitive. */
  findDistrict(
    tx: Tx,
    warehouseId: string,
    stateCode: string,
    district: string,
  ): Promise<AreaRecord | null> {
    return withPrismaErrors(() =>
      tx.wmsServiceArea.findFirst({
        where: {
          warehouseId,
          kind: 'DISTRICT',
          stateCode,
          district: { equals: district, mode: 'insensitive' },
        },
        select: AREA,
      }),
    );
  }

  async pins(areaId: string): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.wmsServiceAreaPin.findMany({
        where: { areaId },
        select: { pinCode: true },
        orderBy: { pinCode: 'asc' },
      }),
    );
    return rows.map((r) => r.pinCode);
  }

  createArea(
    tx: Tx,
    data: {
      warehouseId: string;
      kind: AreaKind;
      stateCode: string;
      district: string;
      priority: AreaPriority;
      userId: string;
    },
  ): Promise<AreaRecord> {
    const { userId, ...rest } = data;
    return withPrismaErrors(() =>
      tx.wmsServiceArea.create({
        data: { ...rest, createdByUserId: userId, updatedByUserId: userId },
        select: AREA,
      }),
    );
  }

  async updateArea(
    tx: Tx,
    id: string,
    data: { stateCode?: string; district?: string; priority?: AreaPriority; userId: string },
  ): Promise<void> {
    const { userId, ...rest } = data;
    await withPrismaErrors(() =>
      tx.wmsServiceArea.update({ where: { id }, data: { ...rest, updatedByUserId: userId } }),
    );
  }

  /** PINs of `pins` this warehouse already serves, with their area. */
  existing(
    tx: Tx,
    warehouseId: string,
    pins: readonly string[],
  ): Promise<{ pinCode: string; areaId: string }[]> {
    if (pins.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      tx.wmsServiceAreaPin.findMany({
        where: { warehouseId, pinCode: { in: [...pins] } },
        select: { pinCode: true, areaId: true },
      }),
    );
  }

  async addPins(
    tx: Tx,
    warehouseId: string,
    areaId: string,
    pins: readonly string[],
    priorityRank: number,
  ): Promise<void> {
    if (pins.length === 0) return;
    await withPrismaErrors(() =>
      tx.wmsServiceAreaPin.createMany({
        data: pins.map((pinCode) => ({ warehouseId, pinCode, areaId, priorityRank })),
      }),
    );
  }

  async removePins(tx: Tx, warehouseId: string, pins: readonly string[]): Promise<void> {
    if (pins.length === 0) return;
    await withPrismaErrors(() =>
      tx.wmsServiceAreaPin.deleteMany({ where: { warehouseId, pinCode: { in: [...pins] } } }),
    );
  }

  /** Moves PINs (or every PIN of `fromAreaId`) into an area with a new rank. */
  async movePins(
    tx: Tx,
    warehouseId: string,
    fromAreaId: string,
    pins: readonly string[] | 'ALL',
    toAreaId: string,
    priorityRank: number,
  ): Promise<number> {
    const result = await withPrismaErrors(() =>
      tx.wmsServiceAreaPin.updateMany({
        where: {
          warehouseId,
          areaId: fromAreaId,
          ...(pins === 'ALL' ? {} : { pinCode: { in: [...pins] } }),
        },
        data: { areaId: toAreaId, priorityRank },
      }),
    );
    return result.count;
  }

  async setRank(tx: Tx, areaId: string, priorityRank: number): Promise<void> {
    await withPrismaErrors(() =>
      tx.wmsServiceAreaPin.updateMany({ where: { areaId }, data: { priorityRank } }),
    );
  }

  async deleteAreas(tx: Tx, warehouseId: string, ids: readonly string[]): Promise<number> {
    const result = await withPrismaErrors(() =>
      tx.wmsServiceArea.deleteMany({ where: { warehouseId, id: { in: [...ids] } } }),
    );
    return result.count;
  }

  /** Recounts every area of the warehouse and drops the ones left without PINs. */
  async refreshCounts(tx: Tx, warehouseId: string): Promise<number> {
    await tx.$executeRaw`
      UPDATE "warehouse_service_areas" a
      SET "pinCount" = (SELECT count(*) FROM "warehouse_service_area_pins" p WHERE p."areaId" = a."id")
      WHERE a."warehouseId" = ${warehouseId}::uuid`;
    await tx.$executeRaw`
      DELETE FROM "warehouse_service_areas"
      WHERE "warehouseId" = ${warehouseId}::uuid AND "pinCount" = 0`;
    return withPrismaErrors(() => tx.wmsServiceAreaPin.count({ where: { warehouseId } }));
  }

  /** The complete coverage of a warehouse (the coverage event payload). */
  entries(tx: Tx, warehouseId: string): Promise<{ pinCode: string; priority: number }[]> {
    return withPrismaErrors(async () =>
      (
        await tx.wmsServiceAreaPin.findMany({
          where: { warehouseId },
          select: { pinCode: true, priorityRank: true },
          orderBy: { pinCode: 'asc' },
        })
      ).map((r) => ({ pinCode: r.pinCode, priority: r.priorityRank })),
    );
  }

  /** Warehouses serving a PIN, best rank first. */
  candidates(pinCode: string): Promise<{ warehouseId: string; priorityRank: number }[]> {
    return withPrismaErrors(() =>
      this.db.wmsServiceAreaPin.findMany({
        where: { pinCode },
        select: { warehouseId: true, priorityRank: true },
        orderBy: { priorityRank: 'asc' },
        take: 50,
      }),
    );
  }

  /** PIN counts per warehouse and area kind (setup checklist). */
  async counts(
    warehouseIds: readonly string[],
    tx?: Tx,
  ): Promise<{ warehouseId: string; kind: AreaKind; pins: number }[]> {
    if (warehouseIds.length === 0) return [];
    const rows = await withPrismaErrors(() =>
      (tx ?? this.db).wmsServiceArea.groupBy({
        by: ['warehouseId', 'kind'],
        where: { warehouseId: { in: [...warehouseIds] } },
        _sum: { pinCount: true },
      }),
    );
    return rows.map((r) => ({
      warehouseId: r.warehouseId,
      kind: r.kind,
      pins: r._sum.pinCount ?? 0,
    }));
  }

  /** Districts already used in a state. */
  async districts(stateCode: string): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.wmsServiceArea.findMany({
        where: { stateCode, kind: 'DISTRICT' },
        select: { district: true },
        distinct: ['district'],
        take: 500,
      }),
    );
    return rows.map((r) => r.district).filter((d): d is string => d !== null);
  }
}
