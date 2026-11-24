import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { WarehouseScope } from '../../middleware/access.js';

export type BackorderRow = Prisma.WmsBackorderGetPayload<object>;
export type BackorderStatus = BackorderRow['status'];

/** Only place that touches `warehouse_backorders` (W3.14 backorder queue). */
export class BackordersRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async create(tx: Tx, data: Prisma.WmsBackorderUncheckedCreateInput): Promise<BackorderRow> {
    return tx.wmsBackorder.create({ data });
  }

  get(id: string): Promise<BackorderRow | null> {
    return withPrismaErrors(() => this.db.wmsBackorder.findUnique({ where: { id } }));
  }

  async lock(tx: Tx, id: string): Promise<BackorderRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_backorders" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return tx.wmsBackorder.findUnique({ where: { id } });
  }

  async update(tx: Tx, id: string, data: Prisma.WmsBackorderUncheckedUpdateInput) {
    return tx.wmsBackorder.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  ofOrder(orderId: string, tx?: Tx): Promise<BackorderRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsBackorder.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    );
  }

  /** Queue: by promise date (none last), then age; keyset on (promiseDate, id). */
  list(
    scope: WarehouseScope,
    f: { status?: BackorderStatus; warehouseId?: string; orderId?: string; variantId?: string },
    page: { limit: number; offset: number | null; afterId: string | null },
  ): Promise<BackorderRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsBackorder.findMany({
        where: {
          ...(f.status === undefined ? {} : { status: f.status }),
          ...(f.orderId === undefined ? {} : { orderId: f.orderId }),
          ...(f.variantId === undefined ? {} : { variantId: f.variantId }),
          ...(f.warehouseId !== undefined
            ? { warehouseId: f.warehouseId }
            : scope === 'ALL'
              ? {}
              : { warehouseId: { in: [...scope] } }),
          ...(page.afterId === null ? {} : { id: { lt: page.afterId } }),
        },
        orderBy: { id: 'desc' },
        take: page.limit + 1,
        ...(page.offset === null ? {} : { skip: page.offset }),
      }),
    );
  }

  async counts(scope: WarehouseScope, warehouseId?: string) {
    const rows = await this.db.wmsBackorder.groupBy({
      by: ['status'],
      where:
        warehouseId !== undefined
          ? { warehouseId }
          : scope === 'ALL'
            ? {}
            : { warehouseId: { in: [...scope] } },
      _count: { _all: true },
      _sum: { qty: true },
    });
    return rows.map((r) => ({ status: r.status, n: r._count._all, units: r._sum.qty ?? 0 }));
  }

  /** OPEN rows due for the allocator: earliest promise first. */
  due(limit: number): Promise<BackorderRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsBackorder.findMany({
        where: { status: 'OPEN', warehouseId: { not: null } },
        orderBy: [{ promiseDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        take: limit,
      }),
    );
  }
}
