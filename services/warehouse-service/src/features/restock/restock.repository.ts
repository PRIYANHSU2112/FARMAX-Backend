import { type Tx, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';
import type { WarehouseScope } from '../../middleware/access.js';

const REQUEST = {
  id: true,
  requestNo: true,
  type: true,
  destWarehouseId: true,
  sourceWarehouseId: true,
  vendorId: true,
  requiredBy: true,
  periodMonth: true,
  notes: true,
  status: true,
  createdBy: true,
  submittedAt: true,
  submittedBy: true,
  decidedAt: true,
  decidedBy: true,
  decisionNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  lines: true,
} as const satisfies Prisma.WmsRestockRequestSelect;
export type RequestRow = Prisma.WmsRestockRequestGetPayload<{ select: typeof REQUEST }>;

const TRANSFER = {
  id: true,
  trNo: true,
  restockRequestId: true,
  sourceWarehouseId: true,
  destWarehouseId: true,
  status: true,
  dispatchedAt: true,
  dispatchedBy: true,
  etaAt: true,
  receivedAt: true,
  receivedBy: true,
  version: true,
  lines: { orderBy: { lineNo: 'asc' } },
} as const satisfies Prisma.WmsTransferSelect;
export type TransferRow = Prisma.WmsTransferGetPayload<{ select: typeof TRANSFER }>;

/** Only place that touches restock requests and transfers. */
export class RestockRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  request(id: string, tx?: Tx): Promise<RequestRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsRestockRequest.findUnique({ where: { id }, select: REQUEST }),
    );
  }

  /** D-62 gate: approved / partly received PROCUREMENT requests of one warehouse (the "PO"). */
  openProcurement(q: {
    warehouseId: string;
    vendorId?: string;
    q?: string;
    limit: number;
  }): Promise<RequestRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsRestockRequest.findMany({
        where: {
          type: 'PROCUREMENT',
          destWarehouseId: q.warehouseId,
          status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] },
          ...(q.vendorId === undefined ? {} : { vendorId: q.vendorId }),
          ...(q.q === undefined || q.q === ''
            ? {}
            : { requestNo: { contains: q.q.toUpperCase() } }),
        },
        select: REQUEST,
        orderBy: { createdAt: 'desc' },
        take: q.limit,
      }),
    );
  }

  async lockRequest(tx: Tx, id: string): Promise<RequestRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_restock_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.request(id, tx);
  }

  createRequest(tx: Tx, data: Prisma.WmsRestockRequestUncheckedCreateInput) {
    return tx.wmsRestockRequest.create({ data, select: REQUEST });
  }

  async updateRequest(
    tx: Tx,
    id: string,
    data: Prisma.WmsRestockRequestUncheckedUpdateInput,
  ): Promise<RequestRow> {
    return tx.wmsRestockRequest.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      select: REQUEST,
    });
  }

  async replaceLines(
    tx: Tx,
    requestId: string,
    lines: Omit<Prisma.WmsRestockLineCreateManyInput, 'requestId'>[],
  ): Promise<void> {
    await tx.wmsRestockLine.deleteMany({ where: { requestId } });
    await tx.wmsRestockLine.createMany({ data: lines.map((l) => ({ ...l, requestId })) });
  }

  async updateLine(
    tx: Tx,
    requestId: string,
    variantId: string,
    data: Prisma.WmsRestockLineUncheckedUpdateInput,
  ) {
    await tx.wmsRestockLine.update({
      where: { requestId_variantId: { requestId, variantId } },
      data,
      select: { requestId: true },
    });
  }

  private requestsWhere(
    scope: WarehouseScope,
    q: { month?: string; status?: string; type?: string; warehouseId?: string },
  ): Prisma.WmsRestockRequestWhereInput {
    return {
      ...(q.warehouseId !== undefined
        ? { OR: [{ destWarehouseId: q.warehouseId }, { sourceWarehouseId: q.warehouseId }] }
        : scope === 'ALL'
          ? {}
          : {
              OR: [
                { destWarehouseId: { in: [...scope] } },
                { sourceWarehouseId: { in: [...scope] } },
              ],
            }),
      ...(q.month === undefined ? {} : { periodMonth: new Date(`${q.month}-01T00:00:00.000Z`) }),
      ...(q.status === undefined ? {} : { status: q.status as RequestRow['status'] }),
      ...(q.type === undefined ? {} : { type: q.type as RequestRow['type'] }),
    };
  }

  requests(
    scope: WarehouseScope,
    q: {
      month?: string;
      status?: string;
      type?: string;
      warehouseId?: string;
      cursor?: string;
      limit: number;
      offset: number | null;
    },
  ) {
    return withPrismaErrors(() =>
      this.db.wmsRestockRequest.findMany({
        where: {
          ...this.requestsWhere(scope, q),
          ...(q.cursor === undefined ? {} : { id: { lt: q.cursor } }),
        },
        select: REQUEST,
        orderBy: { id: 'desc' },
        take: q.limit + 1,
        ...(q.offset === null ? {} : { skip: q.offset }),
      }),
    );
  }

  /** Exact count up to 10,001 (numbered pager). */
  countRequests(
    scope: WarehouseScope,
    q: { month?: string; status?: string; type?: string; warehouseId?: string },
  ) {
    return withPrismaErrors(() =>
      this.db.wmsRestockRequest.count({ where: this.requestsWhere(scope, q), take: 10_001 }),
    );
  }

  transfer(id: string, tx?: Tx): Promise<TransferRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsTransfer.findUnique({ where: { id }, select: TRANSFER }),
    );
  }

  async lockTransfer(tx: Tx, id: string): Promise<TransferRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_transfers" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.transfer(id, tx);
  }

  createTransfer(
    tx: Tx,
    data: Omit<Prisma.WmsTransferUncheckedCreateInput, 'lines'>,
    lines: Omit<Prisma.WmsTransferLineCreateManyInput, 'transferId'>[],
  ) {
    return tx.wmsTransfer.create({
      data: { ...data, lines: { createMany: { data: lines } } },
      select: TRANSFER,
    });
  }

  async updateTransfer(tx: Tx, id: string, data: Prisma.WmsTransferUncheckedUpdateInput) {
    return tx.wmsTransfer.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      select: TRANSFER,
    });
  }

  async receiveTransferLine(tx: Tx, transferId: string, lineNo: number, qty: number) {
    await tx.wmsTransferLine.update({
      where: { transferId_lineNo: { transferId, lineNo } },
      data: { receivedQty: { increment: qty } },
      select: { transferId: true },
    });
  }

  transfers(
    scope: WarehouseScope,
    q: {
      status?: string;
      warehouseId?: string;
      direction?: 'in' | 'out';
      cursor?: string;
      limit: number;
    },
  ) {
    const own =
      q.warehouseId !== undefined
        ? q.direction === 'out'
          ? { sourceWarehouseId: q.warehouseId }
          : q.direction === 'in'
            ? { destWarehouseId: q.warehouseId }
            : { OR: [{ sourceWarehouseId: q.warehouseId }, { destWarehouseId: q.warehouseId }] }
        : scope === 'ALL'
          ? {}
          : {
              OR: [
                { sourceWarehouseId: { in: [...scope] } },
                { destWarehouseId: { in: [...scope] } },
              ],
            };
    return withPrismaErrors(() =>
      this.db.wmsTransfer.findMany({
        where: {
          ...own,
          ...(q.status === undefined ? {} : { status: q.status as TransferRow['status'] }),
          ...(q.cursor === undefined ? {} : { id: { lt: q.cursor } }),
        },
        select: TRANSFER,
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      }),
    );
  }

  /** In-transit transfer units to a warehouse with ETA ≤ `until` (ATP pipeline). */
  async pipeline(warehouseIds: readonly string[] | 'ALL', until: Date) {
    return this.db.$queryRaw<{ destWarehouseId: string; variantId: string; qty: number }[]>`
      SELECT t."destWarehouseId", l."variantId", sum(l."qty" - l."receivedQty")::int AS qty
      FROM "warehouse_transfer_lines" l JOIN "warehouse_transfers" t ON t."id" = l."transferId"
      WHERE t."status" IN ('IN_TRANSIT', 'PARTIALLY_RECEIVED') AND COALESCE(t."etaAt", now()) <= ${until}
      ${warehouseIds === 'ALL' ? Prisma.empty : Prisma.sql`AND t."destWarehouseId" = ANY(${[...warehouseIds]}::uuid[])`}
      GROUP BY 1, 2`;
  }
}
