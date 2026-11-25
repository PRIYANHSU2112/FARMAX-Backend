import type { Paginated } from '@farmx/common/types';
import {
  type Tx,
  cursorArgs,
  isUniqueViolation,
  toPage,
  uniqueViolationFields,
  withPrismaErrors,
} from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { ReservationListQuery, ReservationView } from './reservations.types.js';

const VIEW = {
  id: true,
  orderRef: true,
  status: true,
  pinCode: true,
  expiresAt: true,
  paymentRef: true,
  committedAt: true,
  recoveredFromExpiry: true,
  expiredAt: true,
  rejectedAt: true,
  issuedAt: true,
  releasedAt: true,
  releaseReason: true,
  releasedByUserId: true,
  version: true,
  createdAt: true,
  lines: {
    select: { warehouseId: true, variantId: true, qty: true, releasedQty: true, issuedQty: true },
    orderBy: [{ warehouseId: 'asc' }, { variantId: 'asc' }],
  },
} as const satisfies Prisma.StockReservationSelect;

type Row = Prisma.StockReservationGetPayload<{ select: typeof VIEW }>;

/** Units actually held now: only ACTIVE / COMMITTED reservations hold stock. */
const HOLDING = new Set(['ACTIVE', 'COMMITTED']);

const toView = (r: Row): ReservationView => ({
  ...r,
  status: r.status,
  lines: r.lines.map((l) => ({
    ...l,
    heldQty: HOLDING.has(r.status) ? l.qty - l.releasedQty - l.issuedQty : 0,
  })),
});

export type CreateOutcome =
  { ok: true; view: ReservationView } | { ok: false; conflict: 'IDEMPOTENCY_KEY' | 'ORDER_REF' };

/**
 * Only place that touches `inventory_reservations` / `inventory_reservation_lines`.
 * Every lifecycle change runs under `lock` (SELECT … FOR UPDATE), so commit, release, expiry and
 * the orphan sweep on the same reservation serialise.
 */
export class ReservationsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async findByKey(key: string): Promise<{ view: ReservationView; requestHash: string } | null> {
    const row = await withPrismaErrors(() =>
      this.db.stockReservation.findUnique({
        where: { idempotencyKey: key },
        select: { ...VIEW, requestHash: true },
      }),
    );
    if (row === null) return null;
    const { requestHash, ...rest } = row;
    return { view: toView(rest), requestHash };
  }

  async find(id: string, tx?: Tx): Promise<ReservationView | null> {
    const row = await withPrismaErrors(() =>
      (tx ?? this.db).stockReservation.findUnique({ where: { id }, select: VIEW }),
    );
    return row === null ? null : toView(row);
  }

  /** Newest first: one order may have an old EXPIRED / RELEASED one and a live one. */
  async byOrderRef(orderRef: string, tx?: Tx): Promise<ReservationView[]> {
    const rows = await withPrismaErrors(() =>
      (tx ?? this.db).stockReservation.findMany({
        where: { orderRef },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: VIEW,
      }),
    );
    return rows.map(toView);
  }

  async list(query: ReservationListQuery): Promise<Paginated<ReservationView>> {
    const rows = await withPrismaErrors(() =>
      this.db.stockReservation.findMany({
        where: {
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.orderRef === undefined ? {} : { orderRef: query.orderRef }),
        },
        orderBy: { id: 'desc' },
        select: VIEW,
        ...cursorArgs(query),
      }),
    );
    return toPage(rows.map(toView), query.limit);
  }

  /**
   * Inserts an ACTIVE reservation + lines. A unique violation aborts the Postgres transaction, so
   * it is reported (never swallowed) and the caller rolls back.
   */
  async create(
    tx: Tx,
    data: {
      orderRef: string;
      idempotencyKey: string;
      requestHash: string;
      pinCode: string;
      expiresAt: Date;
      lines: { warehouseId: string; variantId: string; qty: number }[];
    },
  ): Promise<CreateOutcome> {
    try {
      const { lines, ...head } = data;
      const row = await tx.stockReservation.create({
        data: { ...head, lines: { createMany: { data: lines } } },
        select: VIEW,
      });
      return { ok: true, view: toView(row) };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const fields = uniqueViolationFields(error);
      return {
        ok: false,
        conflict: fields.includes('idempotencyKey') ? 'IDEMPOTENCY_KEY' : 'ORDER_REF',
      };
    }
  }

  async lock(tx: Tx, id: string): Promise<ReservationView | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "inventory_reservations" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return rows.length === 0 ? null : this.find(id, tx);
  }

  async update(
    tx: Tx,
    id: string,
    data: Prisma.StockReservationUpdateInput,
  ): Promise<ReservationView> {
    const row = await tx.stockReservation.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      select: VIEW,
    });
    return toView(row);
  }

  async addReleased(
    tx: Tx,
    reservationId: string,
    lines: readonly { warehouseId: string; variantId: string; qty: number }[],
  ): Promise<void> {
    for (const l of lines) {
      if (l.qty <= 0) continue;
      await tx.stockReservationLine.update({
        where: {
          reservationId_warehouseId_variantId: {
            reservationId,
            warehouseId: l.warehouseId,
            variantId: l.variantId,
          },
        },
        data: { releasedQty: { increment: l.qty } },
      });
    }
  }

  /** Issued at dispatch (D-57b). */
  async addIssued(
    tx: Tx,
    reservationId: string,
    lines: readonly { warehouseId: string; variantId: string; qty: number }[],
  ): Promise<void> {
    for (const l of lines)
      await tx.stockReservationLine.update({
        where: {
          reservationId_warehouseId_variantId: {
            reservationId,
            warehouseId: l.warehouseId,
            variantId: l.variantId,
          },
        },
        data: { issuedQty: { increment: l.qty } },
      });
  }

  // ── D-57b warehouse reallocation (§2a.4) + allocation reconcile (§2a.3) ──

  reallocation(key: string, tx?: Tx): Promise<{ result: unknown } | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).stockReallocation.findUnique({ where: { key }, select: { result: true } }),
    );
  }

  async saveReallocation(tx: Tx, key: string, reservationId: string, result: object) {
    await tx.stockReallocation.create({
      data: { key, reservationId, result: result },
      select: { key: true },
    });
  }

  /** Moves `qty` of one SKU line to another warehouse inside the same reservation. */
  async moveLine(
    tx: Tx,
    reservationId: string,
    m: { variantId: string; fromWarehouseId: string; toWarehouseId: string; qty: number },
    fromLine: { qty: number; releasedQty: number; issuedQty: number },
  ): Promise<void> {
    if (fromLine.qty === m.qty && fromLine.releasedQty === 0 && fromLine.issuedQty === 0)
      await tx.$executeRaw`DELETE FROM "inventory_reservation_lines"
        WHERE "reservationId" = ${reservationId}::uuid AND "warehouseId" = ${m.fromWarehouseId}::uuid
          AND "variantId" = ${m.variantId}::uuid`;
    else
      await tx.$executeRaw`UPDATE "inventory_reservation_lines" SET "qty" = "qty" - ${m.qty}
        WHERE "reservationId" = ${reservationId}::uuid AND "warehouseId" = ${m.fromWarehouseId}::uuid
          AND "variantId" = ${m.variantId}::uuid`;
    await tx.$executeRaw`INSERT INTO "inventory_reservation_lines" ("reservationId", "warehouseId", "variantId", "qty")
      VALUES (${reservationId}::uuid, ${m.toWarehouseId}::uuid, ${m.variantId}::uuid, ${m.qty})
      ON CONFLICT ("reservationId", "warehouseId", "variantId")
      DO UPDATE SET "qty" = "inventory_reservation_lines"."qty" + EXCLUDED."qty"`;
  }

  /** Held lines of live reservations at one warehouse, keyset by (reservation, SKU). */
  openLines(
    warehouseId: string,
    after: { reservationId: string; variantId: string } | null,
    limit: number,
  ) {
    return this.db.$queryRaw<
      {
        reservationId: string;
        orderRef: string;
        variantId: string;
        heldQty: number;
        issuedQty: number;
      }[]
    >`
      SELECT l."reservationId", r."orderRef", l."variantId",
        (l."qty" - l."releasedQty" - l."issuedQty")::int AS "heldQty", l."issuedQty"
      FROM "inventory_reservation_lines" l
      JOIN "inventory_reservations" r ON r."id" = l."reservationId"
      WHERE l."warehouseId" = ${warehouseId}::uuid AND r."status" IN ('ACTIVE', 'COMMITTED')
        AND (l."qty" - l."releasedQty" - l."issuedQty") > 0
        ${after === null ? Prisma.empty : Prisma.sql`AND (l."reservationId", l."variantId") > (${after.reservationId}::uuid, ${after.variantId}::uuid)`}
      ORDER BY l."reservationId", l."variantId"
      LIMIT ${limit + 1}`;
  }

  /** ACTIVE reservations past their window, oldest first; skipped if another worker holds them. */
  async lockDue(tx: Tx, limit: number): Promise<{ id: string; orderRef: string }[]> {
    return tx.$queryRaw`
      SELECT "id", "orderRef" FROM "inventory_reservations"
      WHERE "status" = 'ACTIVE' AND "expiresAt" < now()
      ORDER BY "expiresAt" LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
  }

  /** Lines still holding stock, for these reservations. */
  heldLines(
    tx: Tx,
    ids: readonly string[],
  ): Promise<{ warehouseId: string; variantId: string; held: number }[]> {
    return tx.$queryRaw`
      SELECT "warehouseId", "variantId", ("qty" - "releasedQty" - "issuedQty")::int AS "held"
      FROM "inventory_reservation_lines"
      WHERE "reservationId" = ANY(${[...ids]}::uuid[]) AND "qty" - "releasedQty" - "issuedQty" > 0`;
  }

  async markExpired(tx: Tx, ids: readonly string[]): Promise<void> {
    await tx.$executeRaw`
      UPDATE "inventory_reservations"
      SET "status" = 'EXPIRED', "expiredAt" = now(), "version" = "version" + 1, "updatedAt" = now()
      WHERE "id" = ANY(${[...ids]}::uuid[])`;
  }

  /** Live reservations older than `olderThan` (orphan-sweep candidates), oldest first. */
  async staleLive(olderThan: Date, limit: number): Promise<{ id: string; orderRef: string }[]> {
    return withPrismaErrors(() =>
      this.db.stockReservation.findMany({
        where: { status: { in: ['ACTIVE', 'COMMITTED'] }, createdAt: { lt: olderThan } },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: { id: true, orderRef: true },
      }),
    );
  }
}
