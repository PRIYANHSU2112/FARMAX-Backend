import { randomUUID } from 'node:crypto';

import { type Tx, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import type {
  CartLineRow,
  CartOwner,
  CartRow,
  LineWriteResult,
  LockedCart,
  MergeResult,
} from './cart.types.js';

/** Live cart of an owner. Guest carts expire (sliding); merged carts are terminal. */
const ownerIs = (o: CartOwner) =>
  o.userId === undefined
    ? Prisma.sql`"guestToken" = ${o.guestToken}::uuid AND "expiresAt" > now()`
    : Prisma.sql`"userId" = ${o.userId}::uuid`;

interface LockRow {
  id: string;
  version: number;
  guestToken: string | null;
  couponCode: string | null;
}

/**
 * Only place that touches `carts` / `cart_items`.
 *
 * Concurrency model: every write runs in a transaction that FIRST locks the cart row
 * (`lock` → `SELECT … FOR UPDATE`), then runs ONE statement that reads the lines (a fresh
 * READ COMMITTED snapshot, taken after the lock), checks the limits, writes the line and bumps
 * `version`. Lock order is always cart → items, the same order the checkout must use, so writers
 * serialise per cart and can never deadlock. Nothing is read-modified-written in the app.
 */
export class CartRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Cart + lines in one round trip (oldest line first). */
  async find(owner: CartOwner): Promise<CartRow | null> {
    const rows = await withPrismaErrors(
      () => this.db.$queryRaw<(Omit<CartRow, 'lines'> & { lines: CartLineRow[] })[]>`
        SELECT c."id", c."userId", c."guestToken", c."couponCode", c."version",
          COALESCE(
            json_agg(json_build_object(
              'variantId', i."variantId", 'qty', i."qty", 'unitPriceSnapshot', i."unitPriceSnapshot"::text
            ) ORDER BY i."addedAt", i."variantId") FILTER (WHERE i."variantId" IS NOT NULL),
            '[]'::json) AS "lines"
        FROM "carts" c
        LEFT JOIN "cart_items" i ON i."cartId" = c."id"
        WHERE ${ownerIs(owner)} AND c."status" = 'ACTIVE'
        GROUP BY c."id"`,
    );
    return rows[0] ?? null;
  }

  /** Cheap pre-check before a merge (indexed): is there a live guest cart for this token? */
  async guestCartExists(guestToken: string): Promise<boolean> {
    const rows = await withPrismaErrors(
      () => this.db.$queryRaw<{ one: number }[]>`
        SELECT 1 AS "one" FROM "carts"
        WHERE "guestToken" = ${guestToken}::uuid AND "status" = 'ACTIVE' AND "expiresAt" > now()
        LIMIT 1`,
    );
    return rows.length > 0;
  }

  /**
   * Locks the owner's live cart; creates it when `create` (a guest always gets a NEW random token:
   * an expired or merged token is never revived). Returns null when there is no cart to lock.
   */
  async lock(
    tx: Tx,
    owner: CartOwner,
    create: boolean,
    guestTtlDays: number,
  ): Promise<LockedCart | null> {
    const found = await this.selectForUpdate(tx, owner);
    if (found !== null) return { ...found, created: false };
    if (!create) return null;

    if (owner.userId === undefined) {
      const token = randomUUID();
      const rows = await tx.$queryRaw<LockRow[]>`
        INSERT INTO "carts" ("id", "guestToken", "expiresAt")
        VALUES (${uuidv7()}::uuid, ${token}::uuid, now() + make_interval(days => ${guestTtlDays}::int))
        RETURNING "id", "version", "guestToken", "couponCode"`;
      const row = rows[0];
      if (row === undefined) throw new Error('guest cart not created');
      return { ...row, created: true };
    }
    // A parallel first write of the same user may win the insert: then wait for and lock its row.
    const rows = await tx.$queryRaw<LockRow[]>`
      INSERT INTO "carts" ("id", "userId") VALUES (${uuidv7()}::uuid, ${owner.userId}::uuid)
      ON CONFLICT ("userId") DO NOTHING
      RETURNING "id", "version", "guestToken", "couponCode"`;
    const row = rows[0] ?? (await this.selectForUpdate(tx, owner));
    if (row === null) throw new Error('customer cart not created');
    return { ...row, created: rows[0] !== undefined };
  }

  private async selectForUpdate(tx: Tx, owner: CartOwner): Promise<LockRow | null> {
    const rows = await tx.$queryRaw<LockRow[]>`
      SELECT "id", "version", "guestToken", "couponCode" FROM "carts"
      WHERE ${ownerIs(owner)} AND "status" = 'ACTIVE'
      FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * "+" / Add to cart: qty is ADDED to the line (two parallel taps = +2, never lost). The new total
   * must stay within [min, max]; a new line needs a free slot (≤ maxLines). Refused → nothing
   * changes and `qty` / `version` come back null. Guest expiry slides on every write.
   */
  async addQty(
    tx: Tx,
    cartId: string,
    a: {
      variantId: string;
      qty: number;
      min: number;
      max: number;
      price: string;
      maxLines: number;
      guestTtlDays: number;
    },
  ): Promise<LineWriteResult> {
    const rows = await tx.$queryRaw<LineWriteResult[]>`
      WITH cur AS (
        SELECT "qty" FROM "cart_items" WHERE "cartId" = ${cartId}::uuid AND "variantId" = ${a.variantId}::uuid
      ), n AS (
        SELECT count(*)::int AS "lines" FROM "cart_items" WHERE "cartId" = ${cartId}::uuid
      ), w AS (
        INSERT INTO "cart_items" ("cartId", "variantId", "qty", "unitPriceSnapshot")
        SELECT ${cartId}::uuid, ${a.variantId}::uuid, ${a.qty}::int, ${a.price}::numeric
        WHERE EXISTS (SELECT 1 FROM cur)
           OR ((SELECT "lines" FROM n) < ${a.maxLines}::int AND ${a.qty}::int BETWEEN ${a.min}::int AND ${a.max}::int)
        ON CONFLICT ("cartId", "variantId") DO UPDATE SET
          "qty" = "cart_items"."qty" + EXCLUDED."qty",
          "unitPriceSnapshot" = EXCLUDED."unitPriceSnapshot",
          "updatedAt" = now()
        WHERE "cart_items"."qty" + EXCLUDED."qty" BETWEEN ${a.min}::int AND ${a.max}::int
        RETURNING "qty"
      ), v AS (${this.bump(cartId, a.guestTtlDays, Prisma.sql`EXISTS (SELECT 1 FROM w)`)})
      SELECT (SELECT "qty" FROM cur) AS "current",
             (SELECT "lines" FROM n) + CASE WHEN NOT EXISTS (SELECT 1 FROM cur) AND EXISTS (SELECT 1 FROM w) THEN 1 ELSE 0 END AS "lines",
             (SELECT "qty" FROM w) AS "qty",
             (SELECT "version" FROM v) AS "version"`;
    return this.one(rows);
  }

  /** Absolute quantity (idempotent: retries converge). Limits are checked by the caller. */
  async setQty(
    tx: Tx,
    cartId: string,
    a: { variantId: string; qty: number; price: string; maxLines: number; guestTtlDays: number },
  ): Promise<LineWriteResult> {
    const rows = await tx.$queryRaw<LineWriteResult[]>`
      WITH cur AS (
        SELECT "qty" FROM "cart_items" WHERE "cartId" = ${cartId}::uuid AND "variantId" = ${a.variantId}::uuid
      ), n AS (
        SELECT count(*)::int AS "lines" FROM "cart_items" WHERE "cartId" = ${cartId}::uuid
      ), w AS (
        INSERT INTO "cart_items" ("cartId", "variantId", "qty", "unitPriceSnapshot")
        SELECT ${cartId}::uuid, ${a.variantId}::uuid, ${a.qty}::int, ${a.price}::numeric
        WHERE EXISTS (SELECT 1 FROM cur) OR (SELECT "lines" FROM n) < ${a.maxLines}::int
        ON CONFLICT ("cartId", "variantId") DO UPDATE SET
          "qty" = EXCLUDED."qty", "unitPriceSnapshot" = EXCLUDED."unitPriceSnapshot", "updatedAt" = now()
        RETURNING "qty"
      ), v AS (${this.bump(cartId, a.guestTtlDays, Prisma.sql`EXISTS (SELECT 1 FROM w)`)})
      SELECT (SELECT "qty" FROM cur) AS "current",
             (SELECT "lines" FROM n) + CASE WHEN NOT EXISTS (SELECT 1 FROM cur) AND EXISTS (SELECT 1 FROM w) THEN 1 ELSE 0 END AS "lines",
             (SELECT "qty" FROM w) AS "qty",
             (SELECT "version" FROM v) AS "version"`;
    return this.one(rows);
  }

  /** Removes one line (no-op when absent: the version does not move). */
  async removeLine(
    tx: Tx,
    cartId: string,
    variantId: string,
    guestTtlDays: number,
  ): Promise<LineWriteResult> {
    const rows = await tx.$queryRaw<LineWriteResult[]>`
      WITH d AS (
        DELETE FROM "cart_items" WHERE "cartId" = ${cartId}::uuid AND "variantId" = ${variantId}::uuid
        RETURNING "qty"
      ), n AS (
        SELECT count(*)::int AS "lines" FROM "cart_items" WHERE "cartId" = ${cartId}::uuid
      ), v AS (${this.bump(cartId, guestTtlDays, Prisma.sql`EXISTS (SELECT 1 FROM d)`)})
      SELECT (SELECT "qty" FROM d) AS "current",
             (SELECT "lines" FROM n) - (SELECT count(*)::int FROM d) AS "lines",
             NULL::int AS "qty",
             (SELECT "version" FROM v) AS "version"`;
    return this.one(rows);
  }

  /** Empties the cart (and drops the coupon). Returns the new version. */
  async clear(tx: Tx, cartId: string, guestTtlDays: number): Promise<number> {
    const rows = await tx.$queryRaw<{ version: number }[]>`
      WITH d AS (DELETE FROM "cart_items" WHERE "cartId" = ${cartId}::uuid)
      UPDATE "carts" SET "version" = "version" + 1, "couponCode" = NULL, "updatedAt" = now(),
        "expiresAt" = CASE WHEN "guestToken" IS NULL THEN NULL ELSE now() + make_interval(days => ${guestTtlDays}::int) END
      WHERE "id" = ${cartId}::uuid
      RETURNING "version"`;
    return this.one(rows).version;
  }

  async setCoupon(tx: Tx, cartId: string, code: string | null): Promise<number> {
    const rows = await tx.$queryRaw<{ version: number }[]>`
      UPDATE "carts" SET "couponCode" = ${code}, "version" = "version" + 1, "updatedAt" = now()
      WHERE "id" = ${cartId}::uuid
      RETURNING "version"`;
    return this.one(rows).version;
  }

  /** "I've seen the new prices": every snapshot = the current price. */
  async refreshSnapshots(
    tx: Tx,
    cartId: string,
    prices: ReadonlyMap<string, string>,
  ): Promise<number> {
    const ids = [...prices.keys()];
    const values = [...prices.values()];
    const rows = await tx.$queryRaw<{ version: number }[]>`
      WITH p AS (
        SELECT * FROM unnest(${ids}::uuid[], ${values}::numeric[]) AS t("variantId", "price")
      ), u AS (
        UPDATE "cart_items" i SET "unitPriceSnapshot" = p."price", "updatedAt" = now()
        FROM p
        WHERE i."cartId" = ${cartId}::uuid AND i."variantId" = p."variantId"
          AND i."unitPriceSnapshot" IS DISTINCT FROM p."price"
        RETURNING 1
      )
      UPDATE "carts" SET "version" = "version" + CASE WHEN EXISTS (SELECT 1 FROM u) THEN 1 ELSE 0 END
      WHERE "id" = ${cartId}::uuid
      RETURNING "version"`;
    return this.one(rows).version;
  }

  /**
   * Guest → customer, in ONE statement (the customer cart is already locked by the caller).
   * The guest row is flipped ACTIVE → MERGED with a conditional UPDATE, so a second, parallel
   * merge of the same token finds nothing to merge (exactly once). Duplicate variants are SUMMED,
   * capped at the variant's max order qty (never lowering what the customer already had); new
   * variants only fill the free line slots, oldest first.
   */
  async merge(
    tx: Tx,
    a: { userCartId: string; guestToken: string; maxLines: number; hardMaxQty: number },
  ): Promise<MergeResult> {
    const rows = await tx.$queryRaw<{ merged: number; guestLines: number; mergedLines: number }[]>`
      WITH g AS (
        UPDATE "carts" SET "status" = 'MERGED', "mergedIntoId" = ${a.userCartId}::uuid,
          "version" = "version" + 1, "updatedAt" = now()
        WHERE "guestToken" = ${a.guestToken}::uuid AND "status" = 'ACTIVE' AND "expiresAt" > now()
        RETURNING "id"
      ), src AS (
        SELECT gi."variantId", gi."qty", gi."unitPriceSnapshot",
          COALESCE(p."maxOrderQty", ${a.hardMaxQty}::int) AS "cap",
          (ui."variantId" IS NOT NULL) AS "existing",
          row_number() OVER (PARTITION BY (ui."variantId" IS NOT NULL) ORDER BY gi."addedAt", gi."variantId") AS "rn"
        FROM g
        JOIN "cart_items" gi ON gi."cartId" = g."id"
        LEFT JOIN "cart_items" ui ON ui."cartId" = ${a.userCartId}::uuid AND ui."variantId" = gi."variantId"
        LEFT JOIN "order_variant_projections" p ON p."variantId" = gi."variantId"
      ), room AS (
        SELECT ${a.maxLines}::int - count(*)::int AS "free" FROM "cart_items" WHERE "cartId" = ${a.userCartId}::uuid
      ), ins AS (
        INSERT INTO "cart_items" ("cartId", "variantId", "qty", "unitPriceSnapshot")
        SELECT ${a.userCartId}::uuid, s."variantId", LEAST(s."qty", s."cap"), s."unitPriceSnapshot"
        FROM src s
        WHERE s."existing" OR s."rn" <= (SELECT "free" FROM room)
        ON CONFLICT ("cartId", "variantId") DO UPDATE SET
          "qty" = GREATEST("cart_items"."qty", LEAST("cart_items"."qty" + EXCLUDED."qty",
            COALESCE((SELECT p2."maxOrderQty" FROM "order_variant_projections" p2
                      WHERE p2."variantId" = EXCLUDED."variantId"), ${a.hardMaxQty}::int))),
          "updatedAt" = now()
        RETURNING 1
      ), v AS (
        UPDATE "carts" SET "version" = "version" + 1, "updatedAt" = now()
        WHERE "id" = ${a.userCartId}::uuid AND EXISTS (SELECT 1 FROM g)
        RETURNING "version"
      )
      SELECT (SELECT count(*) FROM g)::int AS "merged",
             (SELECT count(*) FROM src)::int AS "guestLines",
             (SELECT count(*) FROM ins)::int AS "mergedLines"`;
    const r = this.one(rows);
    return { merged: r.merged > 0, guestLines: r.guestLines, mergedLines: r.mergedLines };
  }

  /** Checkout hook: removes ordered quantities (line deleted when fully ordered). */
  /** Bumps the version (checkout claimed this cart state: a second checkout of it → CART_CHANGED). */
  async touch(tx: Tx, cartId: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE "carts" SET "version" = "version" + 1, "updatedAt" = now() WHERE "id" = ${cartId}::uuid`;
  }

  async removeOrdered(
    tx: Tx,
    cartId: string,
    lines: readonly { variantId: string; qty: number }[],
  ): Promise<number> {
    const ids = lines.map((l) => l.variantId);
    const qtys = lines.map((l) => l.qty);
    const rows = await tx.$queryRaw<{ version: number }[]>`
      WITH o AS (
        SELECT * FROM unnest(${ids}::uuid[], ${qtys}::int[]) AS t("variantId", "qty")
      ), d AS (
        DELETE FROM "cart_items" i USING o
        WHERE i."cartId" = ${cartId}::uuid AND i."variantId" = o."variantId" AND i."qty" <= o."qty"
      ), u AS (
        UPDATE "cart_items" i SET "qty" = i."qty" - o."qty", "updatedAt" = now()
        FROM o
        WHERE i."cartId" = ${cartId}::uuid AND i."variantId" = o."variantId" AND i."qty" > o."qty"
      )
      UPDATE "carts" SET "version" = "version" + 1, "couponCode" = NULL, "updatedAt" = now()
      WHERE "id" = ${cartId}::uuid
      RETURNING "version"`;
    return this.one(rows).version;
  }

  /** CTE: bump the version (and slide a guest's expiry) only when `when` holds. */
  private bump(cartId: string, guestTtlDays: number, when: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      UPDATE "carts" SET "version" = "version" + 1, "updatedAt" = now(),
        "expiresAt" = CASE WHEN "guestToken" IS NULL THEN NULL ELSE now() + make_interval(days => ${guestTtlDays}::int) END
      WHERE "id" = ${cartId}::uuid AND ${when}
      RETURNING "version"`;
  }

  private one<T>(rows: T[]): T {
    const row = rows[0];
    if (row === undefined) throw new Error('cart statement returned no row');
    return row;
  }
}
