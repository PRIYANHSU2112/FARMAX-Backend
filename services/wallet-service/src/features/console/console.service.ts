import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import type { AccountStatus, JournalFilter } from '../ledger/index.js';

type Deps = Pick<
  Cradle,
  'runInTransaction' | 'ledgerService' | 'rewardsService' | 'settingsService' | 'auditService'
>;

/**
 * Staff console over the wallet (D-54): reads compose the ledger and rewards features; every
 * write (freeze, unfreeze, settings) is one audited transaction with a reason.
 */
export class ConsoleService {
  constructor(private readonly deps: Deps) {}

  accounts(f: { status?: AccountStatus; userId?: string; cursor?: string; limit: number }) {
    return this.deps.ledgerService.accounts(f);
  }

  /** One customer: wallet, points and the latest movements of both ledgers. */
  async account(userId: string) {
    const [wallet, points, transactions, pointsLedger] = await Promise.all([
      this.deps.ledgerService.balanceOf(userId),
      this.deps.rewardsService.summary(userId),
      this.deps.ledgerService.transactions(userId, { limit: 20 }),
      this.deps.rewardsService.ledger(userId, { limit: 20 }),
    ]);
    return {
      userId,
      wallet,
      points,
      recentTransactions: transactions.items,
      recentPoints: pointsLedger.items,
    };
  }

  journals(f: JournalFilter) {
    return this.deps.ledgerService.journals(f);
  }

  /** FROZEN: debits (checkout, adjustments) refused; refunds and credits still land. */
  async setStatus(actor: Actor, userId: string, status: AccountStatus, reason: string) {
    await this.deps.runInTransaction(async (tx) => {
      const before = await this.deps.ledgerService.accountInTx(tx, userId);
      const after = await this.deps.ledgerService.setStatusInTx(tx, userId, status, reason);
      await this.deps.auditService.record(tx, actor, {
        action: status === 'FROZEN' ? 'wallet.freeze' : 'wallet.unfreeze',
        targetType: 'account',
        targetId: userId,
        before: { status: before?.status ?? 'ACTIVE' },
        after: { status: after.status },
        reason,
      });
    });
    // Read after COMMIT (a pool read inside the transaction would still see the old status).
    return this.deps.ledgerService.balanceOf(userId);
  }

  settings() {
    return this.deps.settingsService.current();
  }

  async setSetting(actor: Actor & { userId: string }, key: string, value: unknown, reason: string) {
    await this.deps.runInTransaction(async (tx) => {
      const change = await this.deps.settingsService.setInTx(tx, key, value, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'wallet.settings.update',
        targetType: 'settings',
        targetId: key,
        before: { value: change.before },
        after: { value: change.after },
        reason,
      });
    });
    this.deps.settingsService.invalidate();
    return this.deps.settingsService.current();
  }
}
