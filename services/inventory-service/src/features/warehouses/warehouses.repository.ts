import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { AllocationCandidate, ProjectedWarehouse, WarehouseView } from './warehouses.types.js';

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
  coverageVersion: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Only place that touches `inventory_warehouses` / `inventory_warehouse_coverage`: a read-only copy
 * of warehouse-service's master data (D-56), written by the event consumer only.
 */
export class WarehousesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  find(id: string, tx?: Tx): Promise<WarehouseView | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).warehouse.findUnique({ where: { id }, select: VIEW }),
    );
  }

  /**
   * Insert, or update only when the incoming version is newer (out-of-order and duplicate events
   * are no-ops). Returns the previous flags (null = nothing changed).
   */
  async upsertNewer(
    tx: Tx,
    w: ProjectedWarehouse,
  ): Promise<{ changed: boolean; allocationChanged: boolean }> {
    const before = await this.lock(tx, w.id);
    if (before !== null && before.version >= w.version)
      return { changed: false, allocationChanged: false };
    const data = {
      code: w.code,
      name: w.name,
      type: w.type,
      addressLine: w.addressLine,
      city: w.city,
      stateCode: w.stateCode,
      pinCode: w.pinCode,
      isActive: w.isActive,
      isAllocatable: w.isAllocatable,
      hasColdChain: w.hasColdChain,
      priority: w.priority,
      version: w.version,
    };
    await withPrismaErrors(() =>
      before === null
        ? tx.warehouse.create({ data: { id: w.id, ...data } })
        : tx.warehouse.update({ where: { id: w.id }, data }),
    );
    const allocationChanged =
      before?.isActive !== w.isActive ||
      before.isAllocatable !== w.isAllocatable ||
      before.hasColdChain !== w.hasColdChain ||
      before.priority !== w.priority;
    return { changed: true, allocationChanged };
  }

  /** A discarded draft (it never held stock): removed with its coverage, if not newer. */
  async deleteIfNotNewer(tx: Tx, id: string, version: number): Promise<boolean> {
    const result = await withPrismaErrors(() =>
      tx.warehouse.deleteMany({ where: { id, version: { lt: version } } }),
    );
    return result.count > 0;
  }

  /**
   * Replaces the coverage when `coverageVersion` is newer. Returns false when the event is stale;
   * throws when the warehouse is not projected yet (the consumer retries the message).
   */
  async replaceCoverageIfNewer(
    tx: Tx,
    warehouseId: string,
    coverageVersion: number,
    entries: readonly { pinCode: string; priority: number }[],
  ): Promise<boolean> {
    const before = await this.lock(tx, warehouseId);
    if (before === null) throw new Error(`warehouse ${warehouseId} not projected yet; retry`);
    if (before.coverageVersion >= coverageVersion) return false;
    await withPrismaErrors(async () => {
      await tx.warehouseCoverage.deleteMany({ where: { warehouseId } });
      if (entries.length > 0)
        await tx.warehouseCoverage.createMany({
          data: entries.map((e) => ({ warehouseId, pinCode: e.pinCode, priority: e.priority })),
        });
      await tx.warehouse.update({ where: { id: warehouseId }, data: { coverageVersion } });
    });
    return true;
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
    return withPrismaErrors(
      () =>
        this.db.$queryRaw<AllocationCandidate[]>`
        SELECT w."id" AS "warehouseId", w."code", c."priority" AS "coveragePriority",
               w."priority" AS "warehousePriority", w."hasColdChain"
        FROM "inventory_warehouse_coverage" c
        JOIN "inventory_warehouses" w ON w."id" = c."warehouseId"
        WHERE c."pinCode" = ${pinCode} AND w."isActive" AND w."isAllocatable"
        ORDER BY c."priority", w."priority", w."code"`,
    );
  }

  private async lock(tx: Tx, id: string): Promise<WarehouseView | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "inventory_warehouses" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return rows.length === 0 ? null : this.find(id, tx);
  }
}
