import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { PromoKind } from '../pricing/index.js';
import type {
  PromoStatus,
  PromotionFields,
  PromotionListQuery,
  PromotionRecord,
  RedemptionView,
  RuleInput,
} from './promotions.types.js';

const SELECT = {
  id: true,
  code: true,
  title: true,
  subtitle: true,
  termsText: true,
  badgeText: true,
  kind: true,
  benefitType: true,
  flatAmount: true,
  percentage: true,
  maxDiscountAmount: true,
  comboBuyQty: true,
  comboGetQty: true,
  comboGetPercent: true,
  bundlePrice: true,
  freeShipping: true,
  scope: true,
  minOrderAmount: true,
  startAt: true,
  endAt: true,
  status: true,
  statusChangedAt: true,
  statusChangedByUserId: true,
  statusReason: true,
  isAutoApply: true,
  isStackable: true,
  priority: true,
  totalUsageLimit: true,
  perFarmLimit: true,
  perUserLimit: true,
  usedCount: true,
  accountType: true,
  farmHistory: true,
  paymentMethod: true,
  isMemberOnly: true,
  isPublic: true,
  version: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
  targets: {
    select: { targetType: true, targetId: true, bundleQty: true },
    orderBy: { id: 'asc' },
  },
  rules: { select: { ruleType: true, value: true }, orderBy: { id: 'asc' } },
} satisfies Prisma.PromotionSelect;

type Row = Prisma.PromotionGetPayload<{ select: typeof SELECT }>;

const dec = (v: { toFixed(n: number): string } | null): string | null =>
  v === null ? null : v.toFixed(2);

const toRecord = (r: Row): PromotionRecord & { rules: RuleInput[] } => ({
  ...r,
  flatAmount: dec(r.flatAmount),
  percentage: dec(r.percentage),
  maxDiscountAmount: dec(r.maxDiscountAmount),
  comboGetPercent: dec(r.comboGetPercent),
  bundlePrice: dec(r.bundlePrice),
  minOrderAmount: r.minOrderAmount.toFixed(2),
});

/** Prisma data of the scalar fields present in `f` (money stays exact as a 2-dp string). */
function scalarData(f: Partial<PromotionFields>) {
  const money = (v: number | null | undefined) =>
    v === undefined ? undefined : v === null ? null : v.toFixed(2);
  /* eslint-disable @typescript-eslint/no-unused-vars -- targets / rules are written separately */
  const {
    targets,
    rules,
    minOrderAmount,
    flatAmount,
    percentage,
    maxDiscountAmount,
    comboGetPercent,
    bundlePrice,
    ...rest
  } = f;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return {
    ...rest,
    ...(minOrderAmount === undefined ? {} : { minOrderAmount: minOrderAmount.toFixed(2) }),
    flatAmount: money(flatAmount),
    percentage: money(percentage),
    maxDiscountAmount: money(maxDiscountAmount),
    comboGetPercent: money(comboGetPercent),
    bundlePrice: money(bundlePrice),
  };
}

/** Only place that touches promotions, promotion_targets, promotion_rule_values and promo_redemptions. */
export class PromotionsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── Checkout (inside the order transaction) ──

  /** Locks the promotions an order uses (id order: no deadlocks) and returns their limits. */
  lockLimits(
    tx: Tx,
    ids: readonly string[],
  ): Promise<
    {
      id: string;
      usedCount: number;
      totalUsageLimit: number | null;
      perFarmLimit: number | null;
      perUserLimit: number | null;
    }[]
  > {
    return tx.$queryRaw`
      SELECT "id", "usedCount", "totalUsageLimit", "perFarmLimit", "perUserLimit"
      FROM "promotions" WHERE "id" = ANY(${[...ids]}::uuid[]) ORDER BY "id" FOR UPDATE`;
  }

  /** Non-reversed redemptions per promotion for a farm and a user (fresh, under the lock). */
  async liveCounts(
    tx: Tx,
    ids: readonly string[],
    farmId: string,
    userId: string,
  ): Promise<Map<string, { farm: number; user: number }>> {
    const rows = await tx.$queryRaw<{ promotionId: string; farm: number; user: number }[]>`
      SELECT "promotionId",
             COUNT(*) FILTER (WHERE "farmId" = ${farmId}::uuid)::int AS "farm",
             COUNT(*) FILTER (WHERE "userId" = ${userId}::uuid)::int AS "user"
      FROM "promo_redemptions"
      WHERE "promotionId" = ANY(${[...ids]}::uuid[]) AND "status" <> 'REVERSED'
      GROUP BY "promotionId"`;
    return new Map(rows.map((r) => [r.promotionId, { farm: r.farm, user: r.user }]));
  }

  async insertRedemption(
    tx: Tx,
    r: {
      promotionId: string;
      farmId: string;
      userId: string;
      orderId: string;
      discountAmount: string;
      items: { orderItemId: string; quantity: number; discountAmount: string }[];
    },
  ): Promise<void> {
    await tx.promoRedemption.create({
      data: {
        promotionId: r.promotionId,
        farmId: r.farmId,
        userId: r.userId,
        orderId: r.orderId,
        discountAmount: r.discountAmount,
        items: { createMany: { data: r.items } },
      },
    });
    await tx.promotion.update({
      where: { id: r.promotionId },
      data: { usedCount: { increment: 1 } },
    });
  }

  /** Reverses every live redemption of an order (failed / rejected / cancelled). */
  async reverseForOrder(tx: Tx, orderId: string): Promise<number> {
    const live = await tx.promoRedemption.findMany({
      where: { orderId, status: { not: 'REVERSED' } },
      select: { id: true, promotionId: true },
    });
    if (live.length === 0) return 0;
    const ids = live.map((r) => r.id);
    await tx.promoRedemptionItem.updateMany({
      where: { redemptionId: { in: ids } },
      data: { status: 'REVERSED' },
    });
    await tx.promoRedemption.updateMany({
      where: { id: { in: ids } },
      data: { status: 'REVERSED' },
    });
    await tx.$executeRaw`
      UPDATE "promotions" SET "usedCount" = GREATEST(0, "usedCount" - 1)
      WHERE "id" = ANY(${live.map((r) => r.promotionId)}::uuid[])`;
    return live.length;
  }

  async create(tx: Tx, f: PromotionFields, userId: string): Promise<string> {
    const row = await tx.promotion.create({
      data: {
        ...scalarData(f),
        title: f.title,
        kind: f.kind,
        benefitType: f.benefitType,
        startAt: f.startAt,
        endAt: f.endAt,
        minOrderAmount: f.minOrderAmount.toFixed(2),
        statusChangedByUserId: userId,
        createdByUserId: userId,
        updatedByUserId: userId,
        targets: {
          create: f.targets.map((t) => ({
            targetType: t.targetType,
            targetId: t.targetId,
            bundleQty: t.bundleQty ?? null,
          })),
        },
        rules: { create: f.rules },
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Versioned update; replaces targets / rules when given. Returns false on a stale version. */
  async update(
    tx: Tx,
    id: string,
    version: number,
    f: Partial<PromotionFields>,
    userId: string,
  ): Promise<boolean> {
    const { count } = await tx.promotion.updateMany({
      where: { id, version, deletedAt: null },
      data: { ...scalarData(f), updatedByUserId: userId, version: { increment: 1 } },
    });
    if (count === 0) return false;
    if (f.targets !== undefined) {
      await tx.promotionTarget.deleteMany({ where: { promotionId: id } });
      await tx.promotionTarget.createMany({
        data: f.targets.map((t) => ({
          promotionId: id,
          targetType: t.targetType,
          targetId: t.targetId,
          bundleQty: t.bundleQty ?? null,
        })),
      });
    }
    if (f.rules !== undefined) {
      await tx.promotionRuleValue.deleteMany({ where: { promotionId: id } });
      await tx.promotionRuleValue.createMany({
        data: f.rules.map((r) => ({ promotionId: id, ...r })),
      });
    }
    return true;
  }

  async setStatus(
    tx: Tx,
    id: string,
    version: number,
    to: PromoStatus,
    reason: string,
    userId: string,
  ): Promise<boolean> {
    const { count } = await tx.promotion.updateMany({
      where: { id, version, deletedAt: null },
      data: {
        status: to,
        statusReason: reason,
        statusChangedAt: new Date(),
        statusChangedByUserId: userId,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
    });
    return count > 0;
  }

  async findById(id: string, tx?: Tx): Promise<(PromotionRecord & { rules: RuleInput[] }) | null> {
    const client = tx ?? this.db;
    const row = await withPrismaErrors(() =>
      client.promotion.findFirst({ where: { id, deletedAt: null }, select: SELECT }),
    );
    return row === null ? null : toRecord(row);
  }

  async list(
    query: PromotionListQuery,
  ): Promise<Paginated<PromotionRecord & { rules: RuleInput[] }>> {
    const rows = await withPrismaErrors(() =>
      this.db.promotion.findMany({
        where: {
          deletedAt: null,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.kind === undefined ? {} : { kind: query.kind }),
          ...(query.code === undefined
            ? {}
            : { code: { startsWith: query.code.trim().toUpperCase() } }),
        },
        orderBy: { id: 'desc' },
        select: SELECT,
        ...cursorArgs(query),
      }),
    );
    const page = toPage(rows, query.limit);
    return { ...page, items: page.items.map(toRecord) };
  }

  /** Live (ACTIVE / PAUSED, not ended) promotions of a kind: the overlap check [R6]. */
  async liveOfKind(tx: Tx, kind: PromoKind, now: Date) {
    const rows = await tx.promotion.findMany({
      where: { kind, deletedAt: null, status: { in: ['ACTIVE', 'PAUSED'] }, endAt: { gt: now } },
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  /** Everything the pricing engine may apply right now (ACTIVE, inside its window). */
  async activeAt(now: Date): Promise<(PromotionRecord & { rules: RuleInput[] })[]> {
    const rows = await withPrismaErrors(() =>
      this.db.promotion.findMany({
        where: { deletedAt: null, status: 'ACTIVE', startAt: { lte: now }, endAt: { gt: now } },
        select: SELECT,
      }),
    );
    return rows.map(toRecord);
  }

  /** Non-reversed redemptions per promotion, for this farm and this user [R7]. */
  async usage(promotionIds: readonly string[], farmId: string, userId: string) {
    const out = new Map<string, { farm: number; user: number }>();
    if (promotionIds.length === 0) return out;
    const live = { promotionId: { in: [...promotionIds] }, status: { not: 'REVERSED' as const } };
    const [byFarm, byUser] = await withPrismaErrors(() =>
      Promise.all([
        this.db.promoRedemption.groupBy({
          by: ['promotionId'],
          where: { ...live, farmId },
          _count: { _all: true },
        }),
        this.db.promoRedemption.groupBy({
          by: ['promotionId'],
          where: { ...live, userId },
          _count: { _all: true },
        }),
      ]),
    );
    for (const r of byFarm) out.set(r.promotionId, { farm: r._count._all, user: 0 });
    for (const r of byUser)
      out.set(r.promotionId, { farm: out.get(r.promotionId)?.farm ?? 0, user: r._count._all });
    return out;
  }

  /**
   * Orders this farm has placed. Step 1 has no orders table yet, so the best signal is the
   * distinct orders that redeemed any promotion; Step 2 switches this to the orders table.
   */
  async farmOrderCount(farmId: string): Promise<number> {
    const rows = await withPrismaErrors(() =>
      this.db.promoRedemption.findMany({
        where: { farmId },
        distinct: ['orderId'],
        select: { orderId: true },
      }),
    );
    return rows.length;
  }

  async redemptions(
    promotionId: string,
    query: { cursor?: string; limit: number },
  ): Promise<Paginated<RedemptionView>> {
    const rows = await withPrismaErrors(() =>
      this.db.promoRedemption.findMany({
        where: { promotionId },
        orderBy: { id: 'desc' },
        select: {
          id: true,
          farmId: true,
          userId: true,
          orderId: true,
          discountAmount: true,
          status: true,
          createdAt: true,
        },
        ...cursorArgs(query),
      }),
    );
    const page = toPage(rows, query.limit);
    return {
      ...page,
      items: page.items.map((r) => ({
        ...r,
        discountAmount: r.discountAmount.toFixed(2),
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}
