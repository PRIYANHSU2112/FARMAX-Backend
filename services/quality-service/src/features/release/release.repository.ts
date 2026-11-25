import type { Tx } from '@farmx/database';
import type { Database, Prisma } from '@farmx/database/client';

const withTasks = { tasks: true } as const;

/** `quality_batch_states`, `quality_decisions`, `quality_decision_tasks`, `quality_notices`. */
export class ReleaseRepository {
  constructor(private readonly deps: { db: Database }) {}

  // ── batch state ──
  state(batchId: string, tx?: Tx) {
    return (tx ?? this.deps.db).qaBatchState.findUnique({ where: { batchId } });
  }
  states(batchIds: readonly string[]) {
    return this.deps.db.qaBatchState.findMany({ where: { batchId: { in: [...batchIds] } } });
  }
  ensureState(tx: Tx, batchId: string) {
    return tx.qaBatchState.upsert({ where: { batchId }, create: { batchId }, update: {} });
  }
  ensureStates(tx: Tx, batchIds: readonly string[]) {
    return tx.qaBatchState.createMany({
      data: batchIds.map((batchId) => ({ batchId })),
      skipDuplicates: true,
    });
  }
  /** The concurrency gate: UPDATE … WHERE version = expected. False = someone decided first. */
  async updateStateVersioned(
    tx: Tx,
    batchId: string,
    version: number,
    data: Prisma.QaBatchStateUncheckedUpdateManyInput,
  ) {
    const n = await tx.qaBatchState.updateMany({
      where: { batchId, version },
      data: { ...data, version: { increment: 1 } },
    });
    return n.count === 1;
  }
  setLastDecision(tx: Tx, batchId: string, decisionId: string) {
    return tx.qaBatchState.update({ where: { batchId }, data: { lastDecisionId: decisionId } });
  }

  // ── decisions ──
  decisionByKey(idempotencyKey: string) {
    return this.deps.db.qaDecision.findUnique({ where: { idempotencyKey }, include: withTasks });
  }
  decision(id: string, tx?: Tx) {
    return (tx ?? this.deps.db).qaDecision.findUnique({ where: { id }, include: withTasks });
  }
  decisionsOfBatch(batchId: string) {
    return this.deps.db.qaDecision.findMany({
      where: { batchId },
      orderBy: { decidedAt: 'desc' },
      include: withTasks,
      take: 50,
    });
  }
  decisionsOf(
    batchIds: readonly string[],
    kinds: readonly ('RELEASE' | 'QUARANTINE' | 'RECALL')[],
  ) {
    return this.deps.db.qaDecision.findMany({
      where: { batchId: { in: [...batchIds] }, kind: { in: [...kinds] } },
      orderBy: { decidedAt: 'desc' },
    });
  }
  createDecision(tx: Tx, data: Prisma.QaDecisionUncheckedCreateInput) {
    return tx.qaDecision.create({ data });
  }
  updateDecision(tx: Tx, id: string, data: Prisma.QaDecisionUncheckedUpdateInput) {
    return tx.qaDecision.update({ where: { id }, data });
  }
  stuck(before: Date) {
    return this.deps.db.qaDecision.findMany({
      where: { status: 'APPLYING', decidedAt: { lt: before } },
      select: { id: true, decisionNo: true, batchId: true, decidedAt: true },
      take: 100,
    });
  }

  // ── tasks ──
  insertTasks(tx: Tx, decisionId: string, warehouseIds: readonly string[]) {
    return tx.qaDecisionTask.createMany({
      data: warehouseIds.map((warehouseId) => ({ decisionId, warehouseId })),
      skipDuplicates: true,
    });
  }
  upsertTask(
    tx: Tx,
    decisionId: string,
    warehouseId: string,
    data: Prisma.QaDecisionTaskUncheckedUpdateInput & {
      status: 'PENDING' | 'DONE' | 'FAILED' | 'NO_STOCK' | 'SUPERSEDED';
    },
  ) {
    return tx.qaDecisionTask.upsert({
      where: { decisionId_warehouseId: { decisionId, warehouseId } },
      create: {
        decisionId,
        warehouseId,
        ...(data as Omit<Prisma.QaDecisionTaskUncheckedCreateInput, 'decisionId' | 'warehouseId'>),
      },
      update: data,
    });
  }
  resetFailed(tx: Tx, decisionId: string, warehouseIds: readonly string[]) {
    return tx.qaDecisionTask.updateMany({
      where: { decisionId, warehouseId: { in: [...warehouseIds] }, status: 'FAILED' },
      data: { status: 'PENDING', lastError: null },
    });
  }

  // ── notices ──
  /** True when this (decision, user) notice is new. */
  async insertNotice(tx: Tx, decisionId: string, userId: string): Promise<boolean> {
    const r = await tx.qaNotice.createMany({
      data: [{ decisionId, userId }],
      skipDuplicates: true,
    });
    return r.count > 0;
  }
}
