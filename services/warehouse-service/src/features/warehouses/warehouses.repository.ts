import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { WarehouseScope } from '../../middleware/access.js';
import type { WarehouseListQuery, WarehouseRecord, WarehouseStatus } from './warehouses.types.js';

const SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  status: true,
  parentWarehouseId: true,
  managerUserId: true,
  phone: true,
  email: true,
  addressLine: true,
  landmark: true,
  city: true,
  district: true,
  stateCode: true,
  pinCode: true,
  latitude: true,
  longitude: true,
  tagline: true,
  totalAreaSqft: true,
  capacityKg: true,
  temperatureClasses: true,
  isAllocatable: true,
  priority: true,
  timezone: true,
  statusReason: true,
  statusChangedAt: true,
  activatedAt: true,
  importedAt: true,
  reviewFields: true,
  version: true,
  coverageVersion: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.WmsWarehouseSelect;

type Row = Prisma.WmsWarehouseGetPayload<{ select: typeof SELECT }>;

const toRecord = (r: Row): WarehouseRecord => ({
  ...r,
  latitude: r.latitude?.toString() ?? null,
  longitude: r.longitude?.toString() ?? null,
  capacityKg: r.capacityKg?.toFixed(2) ?? null,
});

/** The search column: lower-case code, name and city (trigram index). */
export const searchTextOf = (w: { code: string; name: string; city: string }): string =>
  `${w.code} ${w.name} ${w.city}`.toLowerCase().slice(0, 400);

/**
 * Who may see what: GLOBAL viewers see everything (drafts included); warehouse-scoped viewers
 * see only their warehouses and never a SETUP draft. Deleted drafts are invisible to everyone.
 */
const visible = (scope: WarehouseScope): Prisma.WmsWarehouseWhereInput =>
  scope === 'ALL'
    ? { deletedAt: null }
    : { deletedAt: null, id: { in: [...scope] }, status: { not: 'SETUP' } };

/** Update payload (the service builds it; only this file touches the Prisma client types). */
export type WarehouseUpdate = Prisma.WmsWarehouseUncheckedUpdateInput;

export type WarehouseWrite = Omit<
  Prisma.WmsWarehouseUncheckedCreateInput,
  'id' | 'version' | 'coverageVersion' | 'createdAt' | 'updatedAt'
>;

/** Only place that touches `warehouse_warehouses` and `warehouse_status_events`. */
export class WarehousesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async list(
    query: WarehouseListQuery,
    scope: WarehouseScope,
  ): Promise<{ page: Paginated<WarehouseRecord>; total: number }> {
    const q = query.q?.trim().toLowerCase();
    const where: Prisma.WmsWarehouseWhereInput = {
      ...visible(scope),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined
        ? {}
        : scope === 'ALL' || query.status !== 'SETUP'
          ? { status: query.status }
          : { id: { in: [] } }),
      ...(query.stateCode === undefined ? {} : { stateCode: query.stateCode }),
      ...(query.city === undefined ? {} : { city: { equals: query.city, mode: 'insensitive' } }),
      ...(q === undefined || q === '' ? {} : { searchText: { contains: q } }),
    };
    const [rows, total] = await withPrismaErrors(() =>
      Promise.all([
        this.db.wmsWarehouse.findMany({
          where,
          select: SELECT,
          orderBy: { id: 'asc' },
          ...cursorArgs(query),
        }),
        this.db.wmsWarehouse.count({ where }),
      ]),
    );
    return { page: toPage(rows.map(toRecord), query.limit), total };
  }

  /** Every visible warehouse matching the filters (export), at most `max`. */
  async listAll(
    query: Omit<WarehouseListQuery, 'cursor' | 'limit'>,
    scope: WarehouseScope,
    max: number,
  ): Promise<WarehouseRecord[]> {
    const { page } = await this.list({ ...query, limit: max }, scope);
    return page.items;
  }

  async find(id: string, tx?: Tx): Promise<WarehouseRecord | null> {
    const row = await withPrismaErrors(() =>
      (tx ?? this.db).wmsWarehouse.findFirst({ where: { id, deletedAt: null }, select: SELECT }),
    );
    return row === null ? null : toRecord(row);
  }

  async findMany(ids: readonly string[]): Promise<WarehouseRecord[]> {
    if (ids.length === 0) return [];
    const rows = await withPrismaErrors(() =>
      this.db.wmsWarehouse.findMany({
        where: { id: { in: [...ids] }, deletedAt: null },
        select: SELECT,
      }),
    );
    return rows.map(toRecord);
  }

  /** Row lock: serialises every change of one warehouse (details, status, coverage). */
  async lock(tx: Tx, id: string): Promise<WarehouseRecord | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "warehouse_warehouses" WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
      FOR UPDATE`;
    return rows.length === 0 ? null : this.find(id, tx);
  }

  async codeExists(code: string): Promise<boolean> {
    const row = await withPrismaErrors(() =>
      this.db.wmsWarehouse.findUnique({ where: { code }, select: { id: true } }),
    );
    return row !== null;
  }

  /** The live central warehouse (not deleted, not inactive), if any. */
  async liveMother(tx?: Tx): Promise<WarehouseRecord | null> {
    const row = await withPrismaErrors(() =>
      (tx ?? this.db).wmsWarehouse.findFirst({
        where: { type: 'MOTHER', deletedAt: null, status: { not: 'INACTIVE' } },
        select: SELECT,
      }),
    );
    return row === null ? null : toRecord(row);
  }

  async create(tx: Tx, data: WarehouseWrite): Promise<WarehouseRecord> {
    const row = await withPrismaErrors(() => tx.wmsWarehouse.create({ data, select: SELECT }));
    return toRecord(row);
  }

  /** Applies the changes and bumps `version` (the caller holds the row lock). */
  async update(
    tx: Tx,
    id: string,
    data: Prisma.WmsWarehouseUncheckedUpdateInput,
  ): Promise<WarehouseRecord> {
    const row = await withPrismaErrors(() =>
      tx.wmsWarehouse.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        select: SELECT,
      }),
    );
    return toRecord(row);
  }

  /** Coverage changed (service-areas feature): the new coverage version. Row lock held. */
  async bumpCoverageVersion(tx: Tx, id: string, userId: string): Promise<number> {
    const row = await withPrismaErrors(() =>
      tx.wmsWarehouse.update({
        where: { id },
        data: { coverageVersion: { increment: 1 }, updatedByUserId: userId },
        select: { coverageVersion: true },
      }),
    );
    return row.coverageVersion;
  }

  async addStatusEvent(
    tx: Tx,
    e: {
      warehouseId: string;
      fromStatus: WarehouseStatus | null;
      toStatus: WarehouseStatus;
      reason: string | null;
      actorUserId: string;
    },
  ): Promise<void> {
    await withPrismaErrors(() => tx.wmsStatusEvent.create({ data: e }));
  }

  async summary(scope: WarehouseScope) {
    const where = visible(scope);
    const [groups, capacity] = await withPrismaErrors(() =>
      Promise.all([
        this.db.wmsWarehouse.groupBy({ by: ['type', 'status'], where, _count: { _all: true } }),
        this.db.wmsWarehouse.aggregate({ where, _sum: { capacityKg: true } }),
      ]),
    );
    return {
      groups: groups.map((g) => ({
        type: g.type,
        status: g.status,
        count: g._count._all,
      })),
      totalCapacityKg: capacity._sum.capacityKg?.toFixed(2) ?? '0.00',
    };
  }

  /** Header search: code, name or city (trigram), best first. */
  async search(q: string, scope: WarehouseScope, limit: number): Promise<WarehouseRecord[]> {
    const rows = await withPrismaErrors(() =>
      this.db.wmsWarehouse.findMany({
        where: { ...visible(scope), searchText: { contains: q.trim().toLowerCase() } },
        select: SELECT,
        orderBy: [{ code: 'asc' }],
        take: limit,
      }),
    );
    return rows.map(toRecord);
  }

  /** Districts already used in one state (district suggestions). */
  async districts(stateCode: string): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.wmsWarehouse.findMany({
        where: { stateCode, deletedAt: null, district: { not: null } },
        select: { district: true },
        distinct: ['district'],
        take: 500,
      }),
    );
    return rows.map((r) => r.district).filter((d): d is string => d !== null);
  }
}
