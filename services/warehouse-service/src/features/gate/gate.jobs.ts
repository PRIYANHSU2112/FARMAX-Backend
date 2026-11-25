import type { Cradle } from '@fastify/awilix';

import { initials, maskMobile } from './gate.rules.js';

const BATCH = 1_000;
const DAY = 86_400_000;

/**
 * Gate jobs (D-62). `gate-pii-retention` (daily): visitors after `gate.visitorRetentionDays`
 * (name → initials, mobile removed); drivers of exited entries after `gate.driverRetentionDays`
 * (mobile masked, licence number removed, name → initials); driver-licence / RC scans deleted from
 * media-service (outside any transaction; a failed delete is retried next run). Retention uses the
 * GLOBAL settings (the longest local value would need per-warehouse batches; Future).
 */
export class GateJobs {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'gateRepository'
      | 'gateRegistersRepository'
      | 'gateSupport'
      | 'mediaClient'
      | 'runInTransaction'
      | 'logger'
    >,
  ) {}

  async retention(
    now = new Date(),
  ): Promise<{ visitors: number; drivers: number; documents: number }> {
    const s = await this.deps.gateSupport.settings('GLOBAL');
    const visitorsBefore = new Date(now.getTime() - s['gate.visitorRetentionDays'] * DAY);
    const driversBefore = new Date(now.getTime() - s['gate.driverRetentionDays'] * DAY);

    const visitors = await this.deps.gateRegistersRepository.visitorsDue(visitorsBefore, BATCH);
    if (visitors.length > 0)
      await this.deps.runInTransaction(async (tx) => {
        for (const v of visitors)
          await this.deps.gateRegistersRepository.anonymizeVisitor(tx, v.id, initials(v.name));
      });

    const drivers = await this.deps.gateRepository.driversDue(driversBefore, BATCH);
    if (drivers.length > 0)
      await this.deps.runInTransaction(async (tx) => {
        for (const d of drivers)
          await this.deps.gateRepository.redactDriver(tx, d.id, {
            driverName: initials(d.driverName),
            driverMobile: maskMobile(d.driverMobile) ?? '',
          });
      });

    const docs = await this.deps.gateRepository.piiDocumentsDue(driversBefore, BATCH);
    let purged = 0;
    if (docs.length > 0) {
      const deleted = await this.deps.mediaClient.deleteKeys(docs.map((d) => d.mediaKey));
      if (deleted === null)
        this.deps.logger.warn(
          { count: docs.length },
          'gate retention: media delete failed; retry next run',
        );
      else {
        await this.deps.runInTransaction(async (tx) => {
          for (const d of docs)
            await this.deps.gateRepository.updateDocument(tx, d.id, {
              mediaKey: null,
              mediaPurgedAt: now,
            });
        });
        purged = docs.length;
      }
    }
    return { visitors: visitors.length, drivers: drivers.length, documents: purged };
  }
}
