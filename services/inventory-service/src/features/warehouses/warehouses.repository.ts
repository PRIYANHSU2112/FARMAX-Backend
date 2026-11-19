import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  AllocationCandidate,
  CoverageEntry,
  CreateWarehouseInput,
  WarehouseListQuery,
  WarehouseView,
} from './warehouses.types.js';

const VIEW = {
  id: true,
  code: true,
  name: true,
  type: true,
  addressLine: true,
  city: true,
  stateCode: true,
  pinCode: true,
  isActive: true,
  isAllocatable: true,
  hasColdChain: true,
  priority: true,
  statusReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Only place that touches `inventory_warehouses` / `inventory_warehouse_coverage`. */
export class WarehousesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async list(query: WarehouseListQuery): Promise<Paginated<WarehouseView>> {
    const where: Prisma.WarehouseWhereInput = {
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { code: { startsWith: query.q, mode: 'insensitive' } },
              { name: { startsWith: query.q, mode: 'insensitive' } },
            ],
          }),
    };
    const rows = await withPrismaErrors(() =>
      this.db.warehouse.findMany({
        where,
        orderBy: { id: 'asc' },
        select: VIEW,
        ...cursorArgs(query),
      }),
    );
    return toPage(rows, query.limit);
  }

  find(id: string, tx?: Tx): Promise<WarehouseView | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).warehouse.findUnique({ where: { id }, select: VIEW }),
    );
  }

  /** Row lock: serialises edits of one warehouse (and its coverage). */
  async lock(tx: Tx, id: string): Promise<WarehouseView | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "inventory_warehouses" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return rows.length === 0 ? null : this.find(id, tx);
  }

  create(tx: Tx, input: CreateWarehouseInput, userId: string): Promise<WarehouseView> {
    return withPrismaErrors(() =>
      tx.warehouse.create({
        data: { ...input, createdByUserId: userId, updatedByUserId: userId },
        select: VIEW,
      }),
    );
  }

  /** Applies the changes and bumps `version` (the caller holds the row lock). */
  update(
    tx: Tx,
    id: string,
    data: Prisma.WarehouseUpdateInput,
    userId: string,
  ): Promise<WarehouseView> {
    return withPrismaErrors(() =>
      tx.warehouse.update({
        where: { id },
        data: { ...data, updatedByUserId: userId, version: { increment: 1 } },
        select: VIEW,
      }),
    );
  }

  coverage(warehouseId: string): Promise<CoverageEntry[]> {
    return withPrismaErrors(() =>
      this.db.warehouseCoverage.findMany({
        where: { warehouseId },
        orderBy: [{ priority: 'asc' }, { pinCode: 'asc' }],
        select: { pinCode: true, priority: true },
      }),
    );
  }

  async replaceCoverage(tx: Tx, warehouseId: string, entries: CoverageEntry[]): Promise<number> {
    const removed = await tx.warehouseCoverage.deleteMany({ where: { warehouseId } });
    if (entries.length > 0)
      await tx.warehouseCoverage.createMany({
        data: entries.map((e) => ({ warehouseId, pinCode: e.pinCode, priority: e.priority })),
      });
    return removed.count;
  }

  /** Ids of active + allocatable warehouses (network availability counts only these). */
  async allocatableIds(): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.warehouse.findMany({
        where: { isActive: true, isAllocatable: true },
        select: { id: true },
      }),
    );
    return rows.map((r) => r.id);
  }

  /** Active, allocatable warehouses serving a PIN, best first (deterministic tie-break on code). */
  candidates(pinCode: string): Promise<AllocationCandidate[]> {
    return withPrismaErrors(() =>
      this.db.$queryRaw<AllocationCandidate[]>`
        SELECT w."id" AS "warehouseId", w."code", c."priority" AS "coveragePriority",
               w."priority" AS "warehousePriority", w."hasColdChain"
        FROM "inventory_warehouse_coverage" c
        JOIN "inventory_warehouses" w ON w."id" = c."warehouseId"
        WHERE c."pinCode" = ${pinCode} AND w."isActive" AND w."isAllocatable"
        ORDER BY c."priority", w."priority", w."code"`,
    );
  }
}
