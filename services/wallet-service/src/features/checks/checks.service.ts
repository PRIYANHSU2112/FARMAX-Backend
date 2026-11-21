import type { Paginated } from '@farmx/common/types';
import type { Cradle } from '@fastify/awilix';

import type { CheckRow, Finding } from './checks.repository.js';

type Deps = Pick<
  Cradle,
  'checksRepository' | 'ledgerService' | 'rewardsService' | 'topupsService' | 'logger'
>;

/** Completed top-ups re-checked each run (a day back covers late events and restarts). */
const TOPUP_WINDOW_MS = 24 * 3_600_000;
const TOPUP_LIMIT = 2_000;

/**
 * Ledger reconciliation (D-54), every 15 min. The DB triggers already make a broken ledger
 * impossible to commit; this job is the independent second look that also catches what triggers
 * cannot see (a completed top-up without its credit, lots drifting from buckets):
 *   WALLET_BALANCE  USER balance ≠ SUM(postings)        WALLET_JOURNAL  a journal ≠ 0
 *   WALLET_TOTAL    all postings ≠ 0                     POINTS_BUCKETS  buckets ≠ postings
 *   POINTS_LOTS     buckets ≠ open lots                  TOPUP_CREDIT    completed top-up ≠ its credit
 * Findings stay OPEN while seen and become RESOLVED when a later run no longer sees them.
 */
export class ChecksService {
  constructor(private readonly deps: Deps) {}

  async run(): Promise<{ open: number; resolved: number }> {
    const started = new Date();
    const findings: Finding[] = [
      ...(await this.deps.ledgerService.mismatches()),
      ...(await this.deps.rewardsService.mismatches()),
      ...(await this.topupCredits()),
    ];
    for (const f of findings) await this.deps.checksRepository.upsert(f, started);
    const resolved = await this.deps.checksRepository.resolveUnseen(started);
    if (findings.length > 0)
      this.deps.logger.error({ findings: findings.length }, 'wallet ledger check found mismatches');
    return { open: findings.length, resolved };
  }

  list(q: { status?: string; cursor?: string; limit: number }): Promise<Paginated<CheckRow>> {
    return this.deps.checksRepository.list(q);
  }

  private async topupCredits(): Promise<Finding[]> {
    const out: Finding[] = [];
    const since = new Date(Date.now() - TOPUP_WINDOW_MS);
    for (const t of await this.deps.topupsService.completedSince(since, TOPUP_LIMIT)) {
      const j = await this.deps.ledgerService.journalByKey(`topup:${t.id}`);
      const credited = t.creditedPaise ?? 0n;
      if (j?.amountPaise !== credited || j.id !== t.journalId)
        out.push({
          checkType: 'TOPUP_CREDIT',
          refId: t.id,
          userId: t.userId,
          expected: credited.toString(),
          actual: j === null ? 'missing' : j.amountPaise.toString(),
        });
    }
    return out;
  }
}
