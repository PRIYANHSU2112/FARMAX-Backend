import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { RuleType } from './storage-rules.rules.js';

const RULE = {
  id: true,
  warehouseId: true,
  type: true,
  name: true,
  subjectCategoryIds: true,
  keepAwayCategoryIds: true,
  allowedZoneId: true,
  minDistanceM: true,
  notes: true,
  status: true,
  version: true,
} as const satisfies Prisma.WmsStorageRuleSelect;

export type RuleRow = Prisma.WmsStorageRuleGetPayload<{ select: typeof RULE }>;
export type RuleWrite = Prisma.WmsStorageRuleUncheckedUpdateInput;

/** Max rules per warehouse (the list is returned whole and paged in the UI). */
export const MAX_RULES = 200;

/** Only place that touches `warehouse_storage_rules`. */
export class StorageRulesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  list(warehouseId: string, type?: RuleType): Promise<RuleRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsStorageRule.findMany({
        where: { warehouseId, ...(type === undefined ? {} : { type }) },
        select: RULE,
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
        take: MAX_RULES,
      }),
    );
  }

  count(tx: Tx, warehouseId: string): Promise<number> {
    return withPrismaErrors(() => tx.wmsStorageRule.count({ where: { warehouseId } }));
  }

  async lock(tx: Tx, warehouseId: string, id: string): Promise<RuleRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_storage_rules" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return withPrismaErrors(() =>
      tx.wmsStorageRule.findFirst({ where: { id, warehouseId }, select: RULE }),
    );
  }

  create(tx: Tx, data: Prisma.WmsStorageRuleUncheckedCreateInput): Promise<RuleRow> {
    return withPrismaErrors(() => tx.wmsStorageRule.create({ data, select: RULE }));
  }

  update(tx: Tx, id: string, data: RuleWrite): Promise<RuleRow> {
    return withPrismaErrors(() =>
      tx.wmsStorageRule.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        select: RULE,
      }),
    );
  }

  async delete(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsStorageRule.delete({ where: { id } }));
  }
}
