import type { Tx } from '@farmx/database';
import type { Database, Prisma } from '@farmx/database/client';

import type { SampleStatus } from './samples.rules.js';

export type SampleWhere = Prisma.QaSampleWhereInput;

/** `quality_samples`, `quality_sample_events`. */
export class SamplesRepository {
  constructor(private readonly deps: { db: Database }) {}

  countByStatus(where: SampleWhere) {
    return this.deps.db.qaSample.groupBy({ by: ['status'], where, _count: { _all: true } });
  }
  list(where: SampleWhere, cursor: string | undefined, take: number) {
    return this.deps.db.qaSample.findMany({
      where,
      orderBy: { id: 'desc' },
      take,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
  }
  byId(id: string, tx?: Tx) {
    return (tx ?? this.deps.db).qaSample.findUnique({ where: { id } });
  }
  events(sampleId: string) {
    return this.deps.db.qaSampleEvent.findMany({ where: { sampleId }, orderBy: { at: 'asc' } });
  }
  findAuto(tx: Tx, receiptId: string, batchId: string) {
    return tx.qaSample.findFirst({
      where: { receiptId, batchId, source: 'AUTO' },
      select: { id: true },
    });
  }
  insert(tx: Tx, data: Prisma.QaSampleUncheckedCreateInput) {
    return tx.qaSample.create({ data });
  }
  insertEvent(tx: Tx, data: Prisma.QaSampleEventUncheckedCreateInput) {
    return tx.qaSampleEvent.create({ data });
  }
  /** Optimistic step: only from `from` at `version`. False = someone else moved it first. */
  async updateVersioned(
    tx: Tx,
    id: string,
    version: number,
    from: readonly SampleStatus[],
    data: Prisma.QaSampleUncheckedUpdateManyInput,
  ) {
    const n = await tx.qaSample.updateMany({
      where: { id, version, status: { in: [...from] } },
      data: { ...data, version: { increment: 1 } },
    });
    return n.count === 1;
  }
  async latestPerLab(labIds: readonly string[]) {
    return this.deps.db.qaSample.findMany({
      where: { labId: { in: [...labIds] } },
      orderBy: { id: 'desc' },
      distinct: ['labId'],
      select: { labId: true, sampleNo: true, createdAt: true },
    });
  }
  firstOfBatch(batchId: string, tx?: Tx) {
    return (tx ?? this.deps.db).qaSample.findFirst({
      where: { batchId },
      select: { sampleNo: true },
    });
  }
  ofBatches(batchIds: readonly string[]) {
    return this.deps.db.qaSample.findMany({
      where: { batchId: { in: [...batchIds] }, status: { not: 'CANCELLED' } },
      orderBy: { id: 'desc' },
    });
  }
}
