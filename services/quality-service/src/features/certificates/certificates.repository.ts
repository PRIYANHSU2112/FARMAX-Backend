import type { Tx } from '@farmx/database';
import type { Database } from '@farmx/database/client';

/** `quality_coa_watches` ("Notify me when it's published"). */
export class CertificatesRepository {
  constructor(private readonly deps: { db: Database }) {}

  async watches(userId: string, batchIds: readonly string[]) {
    return this.deps.db.qaCoaWatch.findMany({ where: { userId, batchId: { in: [...batchIds] } } });
  }
  async addWatches(tx: Tx, userId: string, batchIds: readonly string[]): Promise<void> {
    await tx.qaCoaWatch.createMany({
      data: batchIds.map((batchId) => ({ userId, batchId })),
      skipDuplicates: true,
    });
  }
  async removeWatches(tx: Tx, userId: string, batchIds: readonly string[]): Promise<void> {
    await tx.qaCoaWatch.deleteMany({ where: { userId, batchId: { in: [...batchIds] } } });
  }
  async watcherIds(tx: Tx, batchId: string): Promise<string[]> {
    const rows = await tx.qaCoaWatch.findMany({ where: { batchId }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }
}
