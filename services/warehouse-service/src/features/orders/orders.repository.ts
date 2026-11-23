import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import { type FulfilmentStatus, type Lines, OPEN_STATUSES } from './orders.rules.js';
import type { AllocationRow, HeaderRow, OpenOrderCounts } from './orders.types.js';

const toRow = (r: Omit<AllocationRow, 'lines'> & { lines: unknown }): AllocationRow => ({
  ...r,
  lines: (r.lines ?? {}) as Lines,
});

/** Only place that touches `warehouse_order_headers` and `warehouse_order_allocations`. */
export class OrdersRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async upsertHeader(tx: Tx, h: HeaderRow): Promise<void> {
    const { orderId, ...rest } = h;
    await withPrismaErrors(() =>
      tx.wmsOrderHeader.upsert({ where: { orderId }, create: h, update: rest }),
    );
  }

  /** First commit wins per (order, warehouse); a redelivered or recovered commit adds nothing. */
  async insertAllocations(tx: Tx, rows: Prisma.WmsOrderAllocationCreateManyInput[]): Promise<void> {
    if (rows.length === 0) return;
    await withPrismaErrors(() =>
      tx.wmsOrderAllocation.createMany({ data: rows, skipDuplicates: true }),
    );
  }

  /** Open allocations of an order, row-locked (partial release math). */
  async lockOpen(tx: Tx, orderId: string): Promise<AllocationRow[]> {
    await tx.$queryRaw`
      SELECT 1 FROM "warehouse_order_allocations"
      WHERE "orderId" = ${orderId}::uuid AND "status" IN ('NEW', 'ALLOCATED') FOR UPDATE`;
    const rows = await withPrismaErrors(() =>
      tx.wmsOrderAllocation.findMany({ where: { orderId, status: { in: OPEN_STATUSES } } }),
    );
    return rows.map(toRow);
  }

  /** Forward-only status move of an order's allocations that are in `from`. */
  async move(
    tx: Tx,
    orderId: string,
    from: FulfilmentStatus[],
    data: Prisma.WmsOrderAllocationUpdateManyMutationInput,
  ): Promise<number> {
    const res = await withPrismaErrors(() =>
      tx.wmsOrderAllocation.updateMany({ where: { orderId, status: { in: from } }, data }),
    );
    return res.count;
  }

  async update(
    tx: Tx,
    orderId: string,
    warehouseId: string,
    data: Prisma.WmsOrderAllocationUpdateInput,
  ): Promise<void> {
    await withPrismaErrors(() =>
      tx.wmsOrderAllocation.update({
        where: { orderId_warehouseId: { orderId, warehouseId } },
        data,
      }),
    );
  }

  async openCounts(
    warehouseIds: readonly string[],
    tx?: Tx,
  ): Promise<Map<string, OpenOrderCounts>> {
    const out = new Map<string, OpenOrderCounts>();
    if (warehouseIds.length === 0) return out;
    const groups = await withPrismaErrors(() =>
      (tx ?? this.db).wmsOrderAllocation.groupBy({
        by: ['warehouseId', 'status'],
        where: { warehouseId: { in: [...warehouseIds] }, status: { in: OPEN_STATUSES } },
        _count: { _all: true },
      }),
    );
    for (const g of groups) {
      const c = out.get(g.warehouseId) ?? { new: 0, allocated: 0 };
      if (g.status === 'NEW') c.new = g._count._all;
      else c.allocated = g._count._all;
      out.set(g.warehouseId, c);
    }
    return out;
  }

  /** Newest first (UUID v7 order ids sort by time). */
  async page(
    warehouseId: string,
    statuses: readonly FulfilmentStatus[],
    cursor: string | undefined,
    limit: number,
  ): Promise<{ rows: AllocationRow[]; total: number }> {
    const where: Prisma.WmsOrderAllocationWhereInput = {
      warehouseId,
      status: { in: [...statuses] },
    };
    const [rows, total] = await withPrismaErrors(() =>
      Promise.all([
        this.db.wmsOrderAllocation.findMany({
          where: { ...where, ...(cursor === undefined ? {} : { orderId: { lt: cursor } }) },
          orderBy: { orderId: 'desc' },
          take: limit + 1,
        }),
        this.db.wmsOrderAllocation.count({ where }),
      ]),
    );
    return { rows: rows.map(toRow), total };
  }

  headers(orderIds: readonly string[]): Promise<HeaderRow[]> {
    if (orderIds.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsOrderHeader.findMany({ where: { orderId: { in: [...orderIds] } } }),
    );
  }
}
