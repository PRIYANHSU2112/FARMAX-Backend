import type { Tx } from '@farmx/database';
import type { Database, Prisma } from '@farmx/database/client';

const withParams = {
  params: { orderBy: [{ sortOrder: 'asc' as const }, { code: 'asc' as const }] },
};

/** `quality_sku_specs`, `quality_sku_spec_params`, `quality_sku_spec_history`. */
export class SpecsRepository {
  constructor(private readonly deps: { db: Database }) {}

  load(variantId: string, tx?: Tx) {
    return (tx ?? this.deps.db).qaSkuSpec.findUnique({ where: { variantId }, include: withParams });
  }
  list(variantIds: string[] | undefined, cursor: string | undefined, take: number) {
    return this.deps.db.qaSkuSpec.findMany({
      where: variantIds === undefined ? {} : { variantId: { in: variantIds } },
      include: withParams,
      orderBy: { variantId: 'asc' },
      take,
      ...(cursor === undefined ? {} : { cursor: { variantId: cursor }, skip: 1 }),
    });
  }
  create(tx: Tx, data: Prisma.QaSkuSpecUncheckedCreateInput) {
    return tx.qaSkuSpec.create({ data });
  }
  async updateVersioned(
    tx: Tx,
    variantId: string,
    version: number,
    data: Prisma.QaSkuSpecUncheckedUpdateManyInput,
  ) {
    const n = await tx.qaSkuSpec.updateMany({
      where: { variantId, version },
      data: { ...data, version: { increment: 1 } },
    });
    return n.count === 1;
  }
  async replaceParams(
    tx: Tx,
    variantId: string,
    rows: Omit<Prisma.QaSkuSpecParamCreateManyInput, 'variantId'>[],
  ) {
    await tx.qaSkuSpecParam.deleteMany({ where: { variantId } });
    if (rows.length > 0)
      await tx.qaSkuSpecParam.createMany({ data: rows.map((r) => ({ ...r, variantId })) });
  }
  insertHistory(tx: Tx, data: Prisma.QaSkuSpecHistoryUncheckedCreateInput) {
    return tx.qaSkuSpecHistory.create({ data });
  }
  history(variantId: string) {
    return this.deps.db.qaSkuSpecHistory.findMany({
      where: { variantId },
      orderBy: { version: 'desc' },
      take: 50,
    });
  }
}
