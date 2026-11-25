import type { Tx } from '@farmx/database';
import type { Database, Prisma } from '@farmx/database/client';

type CoaStatus = 'UPLOADED' | 'LINKED' | 'RESULTS_ENTERED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
const ordered = { orderBy: [{ sortOrder: 'asc' as const }, { paramCode: 'asc' as const }] };

/** `quality_coas`, `quality_coa_results`. */
export class CoasRepository {
  constructor(private readonly deps: { db: Database }) {}

  byId(id: string, tx?: Tx) {
    return (tx ?? this.deps.db).qaCoa.findUnique({ where: { id } });
  }
  bySample(sampleId: string, tx?: Tx) {
    return (tx ?? this.deps.db).qaCoa.findUnique({ where: { sampleId } });
  }
  create(tx: Tx, data: Prisma.QaCoaUncheckedCreateInput) {
    return tx.qaCoa.create({ data });
  }
  /** Optimistic change from one of `statusIn` at `version`. False = stale or wrong status. */
  async updateVersioned(
    tx: Tx,
    id: string,
    version: number,
    statusIn: readonly CoaStatus[],
    data: Prisma.QaCoaUncheckedUpdateManyInput,
  ) {
    const n = await tx.qaCoa.updateMany({
      where: { id, version, status: { in: [...statusIn] } },
      data: { ...data, version: { increment: 1 } },
    });
    return n.count === 1;
  }
  update(tx: Tx, id: string, data: Prisma.QaCoaUncheckedUpdateInput) {
    return tx.qaCoa.update({ where: { id }, data });
  }
  results(coaId: string) {
    return this.deps.db.qaCoaResult.findMany({ where: { coaId }, ...ordered });
  }
  async replaceResults(tx: Tx, coaId: string, rows: Prisma.QaCoaResultCreateManyInput[]) {
    await tx.qaCoaResult.deleteMany({ where: { coaId } });
    await tx.qaCoaResult.createMany({ data: rows });
  }
  async paramNames(coaId: string, verdict: 'FAILS' | 'REVIEW', tx?: Tx): Promise<string[]> {
    const rows = await (tx ?? this.deps.db).qaCoaResult.findMany({
      where: { coaId, verdict },
      select: { paramName: true },
    });
    return rows.map((r) => r.paramName);
  }
  list(where: Prisma.QaCoaWhereInput, cursor: string | undefined, take: number) {
    return this.deps.db.qaCoa.findMany({
      where,
      orderBy: { id: 'desc' },
      take,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
  }
  forBatch(batchId: string, tx?: Tx) {
    return (tx ?? this.deps.db).qaCoa.findMany({ where: { batchId }, orderBy: { id: 'desc' } });
  }
  latestOf(
    batchId: string,
    source: 'MANUFACTURER' | 'INDEPENDENT',
    statusIn: readonly CoaStatus[],
  ) {
    return this.deps.db.qaCoa.findFirst({
      where: { batchId, source, status: { in: [...statusIn] } },
      orderBy: { id: 'desc' },
      include: { results: ordered },
    });
  }
  withResults(batchIds: readonly string[], statusIn: readonly CoaStatus[]) {
    return this.deps.db.qaCoa.findMany({
      where: { batchId: { in: [...batchIds] }, status: { in: [...statusIn] } },
      include: { results: ordered },
      orderBy: { id: 'desc' },
    });
  }
  dueToExpire(before: Date) {
    return this.deps.db.qaCoa.findMany({
      where: { status: 'APPROVED', validUntil: { lt: before } },
      select: { id: true, batchId: true, coaNo: true },
      take: 200,
    });
  }
  async expire(tx: Tx, id: string): Promise<boolean> {
    const n = await tx.qaCoa.updateMany({
      where: { id, status: 'APPROVED' },
      data: { status: 'EXPIRED', version: { increment: 1 } },
    });
    return n.count === 1;
  }
}
