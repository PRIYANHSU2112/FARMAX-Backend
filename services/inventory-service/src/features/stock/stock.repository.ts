import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, isUniqueViolation, toPage, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import { one } from '../../middleware/http.js';
import type {
  LedgerListQuery,
  LedgerRow,
  LevelListQuery,
  LevelRow,
  NewLedgerRow,
  OperationLine,
  OperationListQuery,
  OperationView,
  StockOperationStatus,
  StockOperationType,
} from './stock.types.js';

const LEVEL_COLUMNS = Prisma.sql`"id", "warehouseId", "variantId", "onHand", "reserved", "damaged",
  "safetyStock", "reorderLevel", "lowStockAlerted", "version", "updatedAt"`;

const OP_VIEW = {
  id: true,
  type: true,
  status: true,
  warehouseId: true,
  lines: true,
  reference: true,
  reason: true,
  requestedBy: true,
  decidedBy: true,
  decidedAt: true,
  decisionReason: true,
  createdAt: true,
} as const;

/** `lines` is a Json column holding OperationLine[] (written only by this repository). */
const asOp = (row: unknown): OperationView => row as OperationView;

interface Qty {
  onHand: number;
  damaged: number;
}

export interface OperationRecord {
  view: OperationView;
  requestHash: string;
}

/**
 * Only place that touches `inventory_stock_levels`, `inventory_stock_operations`,
 * `inventory_stock_ledger` and the availability tables.
 *
 * Every quantity change is ONE conditional UPDATE (… WHERE <enough> RETURNING): no app-side
 * read-modify-write, no SERIALIZABLE. 0 rows = not enough stock. CHECK constraints are the last
 * guard. Callers touch rows in (warehouseId, variantId) order, so writers never deadlock.
 */
export class StockRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── Quantity changes (all inside the caller's transaction) ──

  /** +onHand, creating the row on first receipt (reorderLevel = the configured default). */
  async addOnHand(tx: Tx, w: string, v: string, q: number, defaultReorder: number): Promise<Qty> {
    const rows = await tx.$queryRaw<Qty[]>`
      INSERT INTO "inventory_stock_levels" ("id", "warehouseId", "variantId", "onHand", "reorderLevel", "updatedAt")
      VALUES (${uuidv7()}::uuid, ${w}::uuid, ${v}::uuid, ${q}, ${defaultReorder}, now())
      ON CONFLICT ("warehouseId", "variantId") DO UPDATE SET
        "onHand" = "inventory_stock_levels"."onHand" + EXCLUDED."onHand",
        "version" = "inventory_stock_levels"."version" + 1, "updatedAt" = now()
      RETURNING "onHand", "damaged"`;
    return one(rows, 'stock level');
  }

  /** −onHand (adjustment out); never below what is reserved. */
  async removeOnHand(tx: Tx, w: string, v: string, q: number): Promise<Qty | null> {
    const rows = await tx.$queryRaw<Qty[]>`
      UPDATE "inventory_stock_levels"
      SET "onHand" = "onHand" - ${q}, "version" = "version" + 1, "updatedAt" = now()
      WHERE "warehouseId" = ${w}::uuid AND "variantId" = ${v}::uuid AND "onHand" - ${q} >= "reserved"
      RETURNING "onHand", "damaged"`;
    return rows[0] ?? null;
  }

  /** onHand → damaged; only stock that is not reserved (may eat into safety stock). */
  async moveToDamaged(tx: Tx, w: string, v: string, q: number): Promise<Qty | null> {
    const rows = await tx.$queryRaw<Qty[]>`
      UPDATE "inventory_stock_levels"
      SET "onHand" = "onHand" - ${q}, "damaged" = "damaged" + ${q}, "version" = "version" + 1,
          "updatedAt" = now()
      WHERE "warehouseId" = ${w}::uuid AND "variantId" = ${v}::uuid AND "onHand" - "reserved" >= ${q}
      RETURNING "onHand", "damaged"`;
    return rows[0] ?? null;
  }

  async writeOffDamaged(tx: Tx, w: string, v: string, q: number): Promise<Qty | null> {
    const rows = await tx.$queryRaw<Qty[]>`
      UPDATE "inventory_stock_levels"
      SET "damaged" = "damaged" - ${q}, "version" = "version" + 1, "updatedAt" = now()
      WHERE "warehouseId" = ${w}::uuid AND "variantId" = ${v}::uuid AND "damaged" >= ${q}
      RETURNING "onHand", "damaged"`;
    return rows[0] ?? null;
  }

  /** reserved += q only if that many units are sellable (onHand − reserved − safetyStock). */
  async hold(tx: Tx, w: string, v: string, q: number): Promise<boolean> {
    const n = await tx.$executeRaw`
      UPDATE "inventory_stock_levels"
      SET "reserved" = "reserved" + ${q}, "version" = "version" + 1, "updatedAt" = now()
      WHERE "warehouseId" = ${w}::uuid AND "variantId" = ${v}::uuid
        AND "onHand" - "reserved" - "safetyStock" >= ${q}`;
    return n === 1;
  }

  async unhold(tx: Tx, w: string, v: string, q: number): Promise<boolean> {
    const n = await tx.$executeRaw`
      UPDATE "inventory_stock_levels"
      SET "reserved" = "reserved" - ${q}, "version" = "version" + 1, "updatedAt" = now()
      WHERE "warehouseId" = ${w}::uuid AND "variantId" = ${v}::uuid AND "reserved" >= ${q}`;
    return n === 1;
  }

  /** Sellable units per warehouse × variant (no lock: allocation plans on it, UPDATEs decide). */
  async sellable(
    warehouseIds: readonly string[],
    variantIds: readonly string[],
  ): Promise<{ warehouseId: string; variantId: string; sellable: number }[]> {
    if (warehouseIds.length === 0 || variantIds.length === 0) return [];
    return withPrismaErrors(
      () =>
        this.db.$queryRaw<{ warehouseId: string; variantId: string; sellable: number }[]>`
        SELECT "warehouseId", "variantId",
               GREATEST(0, "onHand" - "reserved" - "safetyStock")::int AS "sellable"
        FROM "inventory_stock_levels"
        WHERE "warehouseId" = ANY(${[...warehouseIds]}::uuid[])
          AND "variantId" = ANY(${[...variantIds]}::uuid[])`,
    );
  }

  // ── Ledger + dirty marks ──

  async insertLedger(tx: Tx, rows: readonly NewLedgerRow[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.stockLedgerEntry.createMany({ data: [...rows] });
  }

  /** Variants whose network availability must be recomputed by the publisher job. */
  async markDirty(tx: Tx, variantIds: readonly string[]): Promise<void> {
    if (variantIds.length === 0) return;
    await tx.$executeRaw`
      INSERT INTO "inventory_availability_dirty" ("variantId")
      SELECT DISTINCT unnest(${[...variantIds]}::uuid[])
      ON CONFLICT ("variantId") DO NOTHING`;
  }

  /** Every variant stocked in a warehouse (after its active / allocatable flags changed). */
  async markWarehouseDirty(warehouseId: string): Promise<void> {
    await withPrismaErrors(
      () => this.db.$executeRaw`
        INSERT INTO "inventory_availability_dirty" ("variantId")
        SELECT "variantId" FROM "inventory_stock_levels" WHERE "warehouseId" = ${warehouseId}::uuid
        ON CONFLICT ("variantId") DO NOTHING`,
    );
  }

  // ── Levels ──

  async findLevel(warehouseId: string, variantId: string): Promise<LevelRow | null> {
    const rows = await withPrismaErrors(
      () => this.db.$queryRaw<LevelRow[]>`
        SELECT ${LEVEL_COLUMNS} FROM "inventory_stock_levels"
        WHERE "warehouseId" = ${warehouseId}::uuid AND "variantId" = ${variantId}::uuid`,
    );
    return rows[0] ?? null;
  }

  async listLevels(query: LevelListQuery): Promise<Paginated<LevelRow>> {
    const where: Prisma.Sql[] = [];
    if (query.warehouseId !== undefined)
      where.push(Prisma.sql`"warehouseId" = ${query.warehouseId}::uuid`);
    if (query.variantId !== undefined)
      where.push(Prisma.sql`"variantId" = ${query.variantId}::uuid`);
    if (query.lowStock === true)
      where.push(
        Prisma.sql`"reorderLevel" > 0 AND GREATEST(0, "onHand" - "reserved" - "safetyStock") <= "reorderLevel"`,
      );
    if (query.cursor !== undefined) where.push(Prisma.sql`"id" > ${query.cursor}::uuid`);
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const rows = await withPrismaErrors(
      () => this.db.$queryRaw<LevelRow[]>`
        SELECT ${LEVEL_COLUMNS} FROM "inventory_stock_levels"
        ${where.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}`}
        ORDER BY "id" LIMIT ${limit + 1}`,
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null, limit };
  }

  /** Creates the row if needed (zero stock) and sets the thresholds; returns before + after. */
  async setThresholds(
    tx: Tx,
    w: string,
    v: string,
    t: { reorderLevel?: number; safetyStock?: number },
    defaultReorder: number,
  ): Promise<{ before: LevelRow | null; after: LevelRow }> {
    const locked = await tx.$queryRaw<LevelRow[]>`
      SELECT ${LEVEL_COLUMNS} FROM "inventory_stock_levels"
      WHERE "warehouseId" = ${w}::uuid AND "variantId" = ${v}::uuid FOR UPDATE`;
    const before = locked[0] ?? null;
    const reorder = t.reorderLevel ?? before?.reorderLevel ?? defaultReorder;
    const safety = t.safetyStock ?? before?.safetyStock ?? 0;
    const rows = await tx.$queryRaw<LevelRow[]>`
      INSERT INTO "inventory_stock_levels" ("id", "warehouseId", "variantId", "reorderLevel", "safetyStock", "updatedAt")
      VALUES (${uuidv7()}::uuid, ${w}::uuid, ${v}::uuid, ${reorder}, ${safety}, now())
      ON CONFLICT ("warehouseId", "variantId") DO UPDATE SET
        "reorderLevel" = EXCLUDED."reorderLevel", "safetyStock" = EXCLUDED."safetyStock",
        "version" = "inventory_stock_levels"."version" + 1, "updatedAt" = now()
      RETURNING ${LEVEL_COLUMNS}`;
    return { before, after: one(rows, 'stock level') };
  }

  // ── Operations ──

  async findOperationByKey(key: string): Promise<OperationRecord | null> {
    const row = await withPrismaErrors(() =>
      this.db.stockOperation.findUnique({
        where: { idempotencyKey: key },
        select: { ...OP_VIEW, requestHash: true },
      }),
    );
    if (row === null) return null;
    const { requestHash, ...rest } = row;
    return { view: asOp(rest), requestHash };
  }

  /** Insert; a concurrent duplicate key → null (the caller reloads and compares hashes). */
  async createOperation(
    tx: Tx,
    data: {
      type: StockOperationType;
      status: StockOperationStatus;
      warehouseId: string;
      lines: OperationLine[];
      reference: string | null;
      reason: string | null;
      idempotencyKey: string;
      requestHash: string;
      requestedBy: string;
    },
  ): Promise<OperationView | null> {
    try {
      return asOp(
        await tx.stockOperation.create({
          data: { ...data, lines: data.lines as unknown as Prisma.InputJsonValue },
          select: OP_VIEW,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async lockOperation(tx: Tx, id: string): Promise<OperationView | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "inventory_stock_operations" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) return null;
    return (await tx.stockOperation.findUnique({
      where: { id },
      select: OP_VIEW,
    })) as OperationView | null;
  }

  async decideOperation(
    tx: Tx,
    id: string,
    status: StockOperationStatus,
    userId: string,
    reason: string,
  ): Promise<OperationView> {
    return asOp(
      await tx.stockOperation.update({
        where: { id },
        data: { status, decidedBy: userId, decidedAt: new Date(), decisionReason: reason },
        select: OP_VIEW,
      }),
    );
  }

  findOperation(id: string): Promise<OperationView | null> {
    return withPrismaErrors(() =>
      this.db.stockOperation.findUnique({ where: { id }, select: OP_VIEW }),
    ) as Promise<OperationView | null>;
  }

  async listOperations(query: OperationListQuery): Promise<Paginated<OperationView>> {
    const rows = await withPrismaErrors(() =>
      this.db.stockOperation.findMany({
        where: {
          ...(query.warehouseId === undefined ? {} : { warehouseId: query.warehouseId }),
          ...(query.type === undefined ? {} : { type: query.type }),
          ...(query.status === undefined ? {} : { status: query.status }),
        },
        orderBy: { id: 'desc' },
        select: OP_VIEW,
        ...cursorArgs(query),
      }),
    );
    return toPage(rows.map(asOp), query.limit);
  }

  async listLedger(query: LedgerListQuery): Promise<Paginated<LedgerRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.stockLedgerEntry.findMany({
        where: {
          ...(query.warehouseId === undefined ? {} : { warehouseId: query.warehouseId }),
          ...(query.variantId === undefined ? {} : { variantId: query.variantId }),
          ...(query.type === undefined ? {} : { type: query.type }),
          ...(query.from === undefined && query.to === undefined
            ? {}
            : {
                createdAt: {
                  ...(query.from === undefined ? {} : { gte: query.from }),
                  ...(query.to === undefined ? {} : { lt: query.to }),
                },
              }),
        },
        orderBy: { id: 'desc' },
        ...cursorArgs(query),
      }),
    );
    return toPage(rows as LedgerRow[], query.limit);
  }

  // ── Availability publisher ──

  /** Claims up to `limit` dirty variants (removed now; a concurrent change re-marks them). */
  async drainDirty(tx: Tx, limit: number): Promise<string[]> {
    const rows = await tx.$queryRaw<{ variantId: string }[]>`
      DELETE FROM "inventory_availability_dirty"
      WHERE "variantId" IN (
        SELECT "variantId" FROM "inventory_availability_dirty"
        ORDER BY "markedAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING "variantId"`;
    return rows.map((r) => r.variantId);
  }

  levelsOf(tx: Tx, variantIds: readonly string[]): Promise<LevelRow[]> {
    return tx.$queryRaw<LevelRow[]>`
      SELECT ${LEVEL_COLUMNS} FROM "inventory_stock_levels"
      WHERE "variantId" = ANY(${[...variantIds]}::uuid[])
      ORDER BY "warehouseId", "variantId"`;
  }

  async setLowStockFlag(tx: Tx, ids: readonly string[], flag: boolean): Promise<void> {
    if (ids.length === 0) return;
    await tx.$executeRaw`
      UPDATE "inventory_stock_levels" SET "lowStockAlerted" = ${flag}
      WHERE "id" = ANY(${[...ids]}::uuid[])`;
  }

  /** Locks the published state rows of these variants (one publisher per variant at a time). */
  lockStates(tx: Tx, variantIds: readonly string[]): Promise<AvailabilityStateRow[]> {
    return tx.$queryRaw`
      SELECT "variantId", "availableQty", "inStock", "lowStock", "sequence", "nodeStockKey"
      FROM "inventory_availability_state"
      WHERE "variantId" = ANY(${[...variantIds]}::uuid[]) FOR UPDATE`;
  }

  async saveState(tx: Tx, s: AvailabilityStateRow): Promise<void> {
    await tx.inventoryAvailabilityState.upsert({
      where: { variantId: s.variantId },
      create: { ...s, publishedAt: new Date() },
      update: {
        availableQty: s.availableQty,
        inStock: s.inStock,
        lowStock: s.lowStock,
        sequence: s.sequence,
        nodeStockKey: s.nodeStockKey,
        publishedAt: new Date(),
      },
    });
  }
}

/** Last published availability of one variant (network totals + per-node key). */
export interface AvailabilityStateRow {
  variantId: string;
  availableQty: number;
  inStock: boolean;
  lowStock: boolean;
  sequence: bigint;
  /** "nodeId:qty,…" sorted (see stock.rules nodeAvailability). */
  nodeStockKey: string;
}
