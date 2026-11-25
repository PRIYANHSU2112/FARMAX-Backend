import type { Tx } from '@farmx/database';
import type { Database, Prisma } from '@farmx/database/client';

/** `quality_labs`. */
export class LabsRepository {
  constructor(private readonly deps: { db: Database }) {}

  list(status?: 'ACTIVE' | 'INACTIVE') {
    return this.deps.db.qaLab.findMany({
      where: status === undefined ? {} : { status },
      orderBy: { name: 'asc' },
    });
  }
  byId(id: string, tx?: Tx) {
    return (tx ?? this.deps.db).qaLab.findUnique({ where: { id } });
  }
  byIds(ids: readonly string[]) {
    return this.deps.db.qaLab.findMany({ where: { id: { in: [...ids] } } });
  }
  /** The preferred lab if ACTIVE, else the first ACTIVE lab (in-house first). */
  async firstActive(tx: Tx, preferId: string | null) {
    if (preferId !== null) {
      const lab = await tx.qaLab.findFirst({ where: { id: preferId, status: 'ACTIVE' } });
      if (lab !== null) return lab;
    }
    return tx.qaLab.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }
  create(tx: Tx, data: Prisma.QaLabUncheckedCreateInput) {
    return tx.qaLab.create({ data });
  }
  async updateVersioned(
    tx: Tx,
    id: string,
    version: number,
    data: Prisma.QaLabUncheckedUpdateManyInput,
  ) {
    const n = await tx.qaLab.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return n.count === 1;
  }
}
