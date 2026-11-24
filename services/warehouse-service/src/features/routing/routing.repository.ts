import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

export type RuleRow = Prisma.WmsRoutingRuleGetPayload<object>;
export type ThrottleRow = Prisma.WmsRoutingThrottleGetPayload<object>;
export type JsonInput = Prisma.InputJsonValue;

/** Only place that touches the routing tables (W3.12). */
export class RoutingRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  rules(tx?: Tx): Promise<RuleRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsRoutingRule.findMany({
        where: { deletedAt: null },
        orderBy: [{ isDraft: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  rule(id: string, tx?: Tx): Promise<RuleRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsRoutingRule.findFirst({ where: { id, deletedAt: null } }),
    );
  }

  /** Including deleted rules (history of a deleted rule stays readable). */
  ruleAny(id: string): Promise<{ id: string } | null> {
    return withPrismaErrors(() =>
      this.db.wmsRoutingRule.findUnique({ where: { id }, select: { id: true } }),
    );
  }

  rulesAny(ids: readonly string[]): Promise<{ id: string; name: string }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsRoutingRule.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: { id: true, name: true },
      }),
    );
  }

  createRule(tx: Tx, data: Prisma.WmsRoutingRuleUncheckedCreateInput) {
    return tx.wmsRoutingRule.create({ data, select: { id: true } });
  }

  async updateRule(tx: Tx, id: string, data: Prisma.WmsRoutingRuleUncheckedUpdateInput) {
    await tx.wmsRoutingRule.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      select: { id: true },
    });
  }

  /**
   * Live rules get priorities 1..n in the given order (every live id must be listed). Two steps so
   * the unique live-priority index never sees a duplicate; a rule's version moves only when its
   * priority changes.
   */
  async renumber(tx: Tx, ids: readonly string[]) {
    await tx.$executeRaw`UPDATE "warehouse_routing_rules" SET "priority" = "priority" + 500000
      WHERE "deletedAt" IS NULL AND NOT "isDraft"`;
    if (ids.length === 0) return;
    const ps = ids.map((_, i) => i + 1);
    await tx.$executeRaw`UPDATE "warehouse_routing_rules" r
      SET "priority" = v.p,
          "version" = r."version" + CASE WHEN r."priority" - 500000 = v.p THEN 0 ELSE 1 END,
          "updatedAt" = CASE WHEN r."priority" - 500000 = v.p THEN r."updatedAt" ELSE now() END
      FROM unnest(${[...ids]}::uuid[], ${ps}::int[]) AS v(id, p)
      WHERE r."id" = v.id`;
  }

  async addVersion(tx: Tx, data: Prisma.WmsRoutingRuleVersionUncheckedCreateInput) {
    await tx.wmsRoutingRuleVersion.create({ data, select: { id: true } });
  }

  versions(ruleId: string | undefined, before: string | null, limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsRoutingRuleVersion.findMany({
        where: {
          ...(ruleId === undefined ? {} : { ruleId }),
          ...(before === null ? {} : { id: { lt: before } }),
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
      }),
    );
  }

  throttles(tx?: Tx): Promise<ThrottleRow[]> {
    return withPrismaErrors(() => (tx ?? this.db).wmsRoutingThrottle.findMany());
  }

  upsertThrottle(
    tx: Tx,
    warehouseId: string,
    data: {
      paused: boolean;
      maxOrdersPerDay: number | null;
      note: string | null;
      updatedBy: string;
    },
  ) {
    return tx.wmsRoutingThrottle.upsert({
      where: { warehouseId },
      create: { warehouseId, ...data },
      update: { ...data, version: { increment: 1 } },
    });
  }
}
