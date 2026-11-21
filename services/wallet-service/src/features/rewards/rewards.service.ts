import { randomBytes } from 'node:crypto';

import { AppError, ErrorCode, InternalError } from '@farmx/common/errors';
import type { AuthUser, Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { type OrderDeliveredV1, type RefundProcessedV1, WALLET_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { emitWalletEvent } from '../../adapters/events.js';
import { uuidv7 } from '../../adapters/uuid.js';
import { rupees } from '../ledger/index.js';
import {
  addDays,
  addMonths,
  allocate,
  convertRefusal,
  earnPoints,
  reversalPoints,
} from './rewards.rules.js';
import {
  type ConvertInput,
  type ConvertView,
  type PointsAccountRow,
  type PointsEntryView,
  type PointsJournalRow,
  type PointsMove,
  type PointsSystemCode,
  type RewardsSummary,
  toEntryView,
} from './rewards.types.js';

type Deps = Pick<
  Cradle,
  'rewardsRepository' | 'runInTransaction' | 'ledgerService' | 'settingsService' | 'logger'
>;

const JOB_BATCH = 100;
const EXPIRING_WINDOW_DAYS = 30;

const yymmdd = (d = new Date()) => d.toISOString().slice(2, 10).replaceAll('-', '');
const newPointsNo = () => `PJ-${yymmdd()}-${randomBytes(4).toString('hex').toUpperCase()}`;

const refuse = (message: string, reason: string, extra: object = {}) =>
  new AppError(ErrorCode.VALIDATION_ERROR, message, 422, { details: { reason, ...extra } });

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Reward points (D-54), a ledger SEPARATE from wallet money. Every change is one `move`: the
 * customer's points account is locked, one journal + postings (summing to 0) are written, the
 * buckets are updated, and the DB re-checks buckets = SUM(postings) at commit. Lots track which
 * points expire when (FIFO by expiry for spending, expiry and reversal).
 */
export class RewardsService {
  private system: Map<PointsSystemCode, string> | undefined;

  constructor(private readonly deps: Deps) {}

  // ── Earning ──

  /**
   * order.delivered.v1 → points on what was finally paid, PENDING for the hold days (refund
   * window). An open DEBT is settled first. Idempotent per order (lot unique + journal key).
   */
  async earnForOrderInTx(tx: Tx, d: OrderDeliveredV1, correlationId: string): Promise<void> {
    const repo = this.deps.rewardsRepository;
    const s = await this.deps.settingsService.current(tx);
    if (!Number.isInteger(d.netPaidPaise) || d.netPaidPaise <= 0) {
      this.deps.logger.warn(
        { orderId: d.orderId },
        'order.delivered.v1 without netPaidPaise: no points',
      );
      return;
    }
    const pts = earnPoints(BigInt(d.netPaidPaise), s.pointsEarnPaisePerPoint);
    if (pts === 0n) return;
    const account = await repo.lockAccount(tx, d.userId);
    if ((await repo.lotBySource(tx, 'ORDER', d.orderId)) !== null) return;

    const settle = min(pts, account.debtPts);
    const rest = pts - settle;
    const delivered = new Date(d.deliveredAt);
    const availableAt = addDays(delivered, s.pointsHoldDays);
    const immediate = s.pointsHoldDays === 0;
    const journal = await this.move(tx, account, {
      key: `earn:${d.orderId}`,
      userId: d.userId,
      kind: 'EARN',
      points: pts,
      dAvailable: immediate ? rest : 0n,
      dPending: immediate ? 0n : rest,
      dDebt: -settle,
      counterparty: 'POINTS_ISSUED',
      earned: pts,
      title: 'Order reward',
      subtitle: d.orderNo,
      refType: 'ORDER',
      refId: d.orderId,
      metadata: { netPaidPaise: d.netPaidPaise, settledDebtPts: Number(settle) },
      correlationId,
    });
    if (journal === null) return;
    const lot = await repo.insertLot(tx, {
      id: uuidv7(),
      userId: d.userId,
      sourceType: 'ORDER',
      sourceRef: d.orderId,
      journalId: journal.id,
      basePaise: BigInt(d.netPaidPaise),
      earnedPts: pts,
      remainingPts: rest,
      status: rest === 0n ? 'EXHAUSTED' : immediate ? 'AVAILABLE' : 'PENDING',
      availableAt,
      expiresAt: addMonths(availableAt, s.pointsExpiryMonths),
    });
    if (settle > 0n)
      await repo.insertConsumptions(tx, [
        { id: uuidv7(), lotId: lot.id, journalId: journal.id, points: settle },
      ]);
  }

  /** First-UPI-top-up cashback → AVAILABLE at once (top-ups are never refunded). Idempotent. */
  async grantCashbackInTx(
    tx: Tx,
    g: { topupId: string; topupNo: string; userId: string; points: number; basePaise: bigint },
  ): Promise<void> {
    if (g.points <= 0) return;
    const repo = this.deps.rewardsRepository;
    const s = await this.deps.settingsService.current(tx);
    const account = await repo.lockAccount(tx, g.userId);
    if ((await repo.lotBySource(tx, 'TOPUP_CASHBACK', g.topupId)) !== null) return;
    const pts = BigInt(g.points);
    const settle = min(pts, account.debtPts);
    const journal = await this.move(tx, account, {
      key: `cashback:${g.topupId}`,
      userId: g.userId,
      kind: 'CASHBACK',
      points: pts,
      dAvailable: pts - settle,
      dPending: 0n,
      dDebt: -settle,
      counterparty: 'POINTS_ISSUED',
      earned: pts,
      title: 'Top-up cashback',
      subtitle: g.topupNo,
      refType: 'TOPUP',
      refId: g.topupId,
      correlationId: `topup:${g.topupId}`,
    });
    if (journal === null) return;
    const now = new Date();
    const lot = await repo.insertLot(tx, {
      id: uuidv7(),
      userId: g.userId,
      sourceType: 'TOPUP_CASHBACK',
      sourceRef: g.topupId,
      journalId: journal.id,
      basePaise: g.basePaise,
      earnedPts: pts,
      remainingPts: pts - settle,
      status: pts - settle === 0n ? 'EXHAUSTED' : 'AVAILABLE',
      availableAt: now,
      expiresAt: addMonths(now, s.pointsExpiryMonths),
    });
    if (settle > 0n)
      await repo.insertConsumptions(tx, [
        { id: uuidv7(), lotId: lot.id, journalId: journal.id, points: settle },
      ]);
  }

  // ── Reversal ──

  /**
   * payment.refund_processed.v1 → take back the refunded share of the order's points: from the
   * order's own lot first, then other spendable lots (FIFO), and whatever is left becomes DEBT
   * (settled by the next earn). Idempotent per refund.
   */
  async reverseForRefundInTx(tx: Tx, d: RefundProcessedV1, correlationId: string): Promise<void> {
    const repo = this.deps.rewardsRepository;
    const peek = await repo.lotBySource(tx, 'ORDER', d.orderId);
    if (peek === null) return; // nothing earned (yet) on this order
    const account = await repo.lockAccount(tx, peek.userId);
    if ((await repo.journalByKey(tx, `reverse:${d.refundId}`)) !== null) return;
    const lot = await repo.lockLot(tx, peek.id);
    if (lot === null) return;
    const total = reversalPoints(lot, BigInt(d.amountPaise));
    if (total === 0n) return;

    const fromLot = min(lot.remainingPts, total);
    let dPending = 0n;
    let dAvailable = 0n;
    if (lot.status === 'PENDING') dPending = -fromLot;
    else dAvailable = -fromLot;
    let rest = total - fromLot;
    const takes: { lotId: string; points: bigint }[] =
      fromLot > 0n ? [{ lotId: lot.id, points: fromLot }] : [];
    if (rest > 0n) {
      const others = await repo.availableLotsForUpdate(tx, lot.userId, lot.id);
      const plan = allocate(others, rest);
      for (const t of plan.takes) {
        takes.push(t);
        dAvailable -= t.points;
      }
      rest = plan.shortfall;
    }

    const journal = await this.move(tx, account, {
      key: `reverse:${d.refundId}`,
      userId: lot.userId,
      kind: 'REVERSAL',
      points: total,
      dAvailable,
      dPending,
      dDebt: rest,
      counterparty: 'POINTS_REVERSED',
      title: 'Points reversed (refund)',
      subtitle: d.refundId,
      refType: 'ORDER',
      refId: d.orderId,
      metadata: { refundId: d.refundId, refundPaise: d.amountPaise, debtPts: Number(rest) },
      correlationId,
    });
    if (journal === null) return;
    await this.consume(tx, takes, journal.id, lot.id);
    const remaining = lot.remainingPts - fromLot;
    const reversed = lot.reversedPts + total;
    await repo.updateLot(tx, lot.id, {
      remainingPts: remaining,
      reversedPts: reversed,
      ...(remaining === 0n && (lot.status === 'PENDING' || lot.status === 'AVAILABLE')
        ? { status: reversed === lot.earnedPts ? 'REVERSED' : 'EXHAUSTED' }
        : {}),
    });
  }

  // ── Staff adjustment (approved in the adjustments feature) ──

  /**
   * Manual points credit (new AVAILABLE lot, settles DEBT first) or debit (FIFO, never into DEBT:
   * 409 INSUFFICIENT_POINTS). Runs inside the approval transaction; key adj:<id>.
   */
  async adjustInTx(
    tx: Tx,
    a: {
      adjustmentId: string;
      userId: string;
      direction: 'CREDIT' | 'DEBIT';
      points: bigint;
      title: string;
      subtitle: string;
      approvedBy: string;
    },
  ): Promise<PointsJournalRow> {
    const repo = this.deps.rewardsRepository;
    const s = await this.deps.settingsService.current(tx);
    const account = await repo.lockAccount(tx, a.userId);
    const base = {
      key: `adj:${a.adjustmentId}`,
      userId: a.userId,
      kind: 'ADJUSTMENT' as const,
      points: a.points,
      dPending: 0n,
      title: a.title,
      subtitle: a.subtitle,
      refType: 'ADJUSTMENT',
      refId: a.adjustmentId,
      createdBy: a.approvedBy,
    };
    if (a.direction === 'CREDIT') {
      const settle = min(a.points, account.debtPts);
      const journal = await this.move(tx, account, {
        ...base,
        dAvailable: a.points - settle,
        dDebt: -settle,
        counterparty: 'POINTS_ISSUED',
        earned: a.points,
      });
      if (journal === null) throw new InternalError('adjustment already posted');
      const now = new Date();
      const lot = await repo.insertLot(tx, {
        id: uuidv7(),
        userId: a.userId,
        sourceType: 'ADJUSTMENT',
        sourceRef: a.adjustmentId,
        journalId: journal.id,
        earnedPts: a.points,
        remainingPts: a.points - settle,
        status: a.points - settle === 0n ? 'EXHAUSTED' : 'AVAILABLE',
        availableAt: now,
        expiresAt: addMonths(now, s.pointsExpiryMonths),
      });
      if (settle > 0n)
        await repo.insertConsumptions(tx, [
          { id: uuidv7(), lotId: lot.id, journalId: journal.id, points: settle },
        ]);
      return journal;
    }
    if (account.availablePts < a.points)
      throw new AppError(ErrorCode.CONFLICT, 'The customer does not have that many points', 409, {
        details: { reason: 'INSUFFICIENT_POINTS', availablePts: Number(account.availablePts) },
      });
    const plan = allocate(await repo.availableLotsForUpdate(tx, a.userId), a.points);
    if (plan.shortfall > 0n)
      throw new InternalError('points lots do not cover the available balance');
    const journal = await this.move(tx, account, {
      ...base,
      dAvailable: -a.points,
      dDebt: 0n,
      counterparty: 'POINTS_REVERSED',
    });
    if (journal === null) throw new InternalError('adjustment already posted');
    await this.consume(tx, plan.takes, journal.id);
    return journal;
  }

  // ── Conversion ("Convert →") ──

  /**
   * Points → wallet money in ONE transaction (points account, then wallet account — the same lock
   * order as top-up completion). Idempotency-Key replays the first result; same key + other body
   * → 422.
   */
  async convert(
    user: AuthUser,
    idempotencyKey: string,
    hash: string,
    input: ConvertInput,
  ): Promise<ConvertView> {
    const s = await this.deps.settingsService.current();
    const key = `convert:${user.id}:${idempotencyKey}`;
    return this.deps.runInTransaction(async (tx) => {
      const repo = this.deps.rewardsRepository;
      const account = await repo.lockAccount(tx, user.id);
      const earlier = await repo.journalByKey(tx, key);
      if (earlier !== null) return this.replayConvert(tx, earlier, hash);

      const why = convertRefusal(input.points, account.availablePts, {
        min: s.pointsMinConvert,
        step: s.pointsConvertStep,
      });
      if (why !== null)
        throw refuse(
          why === 'INSUFFICIENT_POINTS'
            ? 'Not enough points'
            : `Convert at least ${String(s.pointsMinConvert)} points, in steps of ${String(s.pointsConvertStep)}`,
          why,
          {
            availablePts: Number(account.availablePts),
            minPoints: s.pointsMinConvert,
            stepPoints: s.pointsConvertStep,
          },
        );
      const pts = BigInt(input.points);
      const plan = allocate(await repo.availableLotsForUpdate(tx, user.id), pts);
      if (plan.shortfall > 0n)
        throw new InternalError('points lots do not cover the available balance');
      const paise = pts * BigInt(s.pointValuePaise);

      const journal = await this.move(tx, account, {
        key,
        userId: user.id,
        kind: 'CONVERT',
        points: pts,
        dAvailable: -pts,
        dPending: 0n,
        dDebt: 0n,
        counterparty: 'POINTS_REDEEMED',
        title: 'Redeemed to wallet',
        subtitle: `₹${rupees(paise)}`,
        refType: 'WALLET',
        metadata: { requestHash: hash, creditedPaise: Number(paise) },
        correlationId: key,
      });
      if (journal === null) throw new InternalError('conversion journal not written');
      await this.consume(tx, plan.takes, journal.id);
      const credit = await this.deps.ledgerService.post(tx, {
        idempotencyKey: key,
        userId: user.id,
        kind: 'POINTS_CONVERSION',
        category: 'REWARDS',
        direction: 'CREDIT',
        amountPaise: paise,
        counterparty: 'REWARDS_EXPENSE',
        title: 'Points Redeemed to Cash',
        subtitle: `${pts.toString()} Pts`,
        refType: 'POINTS',
        refId: journal.id,
        metadata: { points: Number(pts), pointsJournalNo: journal.journalNo },
        correlationId: key,
      });
      return {
        pointsJournalNo: journal.journalNo,
        walletJournalNo: credit.journal.journalNo,
        points: Number(pts),
        creditedPaise: Number(paise),
        credited: rupees(paise),
        availablePtsAfter: Number(journal.availableAfter),
        walletBalanceAfterPaise: Number(credit.balanceAfterPaise),
        replayed: false,
      };
    });
  }

  private async replayConvert(
    tx: Tx,
    earlier: PointsJournalRow,
    hash: string,
  ): Promise<ConvertView> {
    const meta = earlier.metadata as { requestHash?: string; creditedPaise?: number } | null;
    if (meta?.requestHash !== hash)
      throw refuse(
        'This Idempotency-Key was used for a different conversion',
        'IDEMPOTENCY_KEY_REUSED',
      );
    const wallet = await this.deps.ledgerService.journalByKey(earlier.idempotencyKey, tx);
    const balance = await this.deps.ledgerService.balanceInTx(tx, earlier.userId);
    const paise = BigInt(meta.creditedPaise ?? 0);
    return {
      pointsJournalNo: earlier.journalNo,
      walletJournalNo: wallet?.journalNo ?? '',
      points: Number(earlier.points),
      creditedPaise: Number(paise),
      credited: rupees(paise),
      availablePtsAfter: Number(earlier.availableAfter),
      walletBalanceAfterPaise: Number(balance),
      replayed: true,
    };
  }

  // ── Jobs ──

  /** PENDING lots past their hold → AVAILABLE (one transaction per lot). */
  async matureDue(): Promise<{ matured: number }> {
    let matured = 0;
    for (const due of await this.deps.rewardsRepository.dueToMature(new Date(), JOB_BATCH)) {
      const done = await this.deps.runInTransaction(async (tx) => {
        const repo = this.deps.rewardsRepository;
        const account = await repo.lockAccount(tx, due.userId);
        const lot = await repo.lockLot(tx, due.id);
        if (lot?.status !== 'PENDING' || lot.availableAt.getTime() > Date.now()) return false;
        if (lot.remainingPts === 0n) {
          await repo.updateLot(tx, lot.id, { status: 'EXHAUSTED' });
          return true;
        }
        await this.move(tx, account, {
          key: `mature:${lot.id}`,
          userId: lot.userId,
          kind: 'MATURE',
          points: lot.remainingPts,
          dAvailable: lot.remainingPts,
          dPending: -lot.remainingPts,
          dDebt: 0n,
          counterparty: null,
          title: 'Points now available',
          subtitle: lot.sourceType === 'ORDER' ? null : lot.sourceType,
          refType: lot.sourceType,
          refId: lot.sourceRef,
        });
        await repo.updateLot(tx, lot.id, { status: 'AVAILABLE' });
        return true;
      });
      if (done) matured += 1;
    }
    return { matured };
  }

  /** AVAILABLE lots past expiry: their remaining points expire. */
  async expireDue(): Promise<{ expired: number }> {
    let expired = 0;
    for (const due of await this.deps.rewardsRepository.dueToExpire(new Date(), JOB_BATCH)) {
      const done = await this.deps.runInTransaction(async (tx) => {
        const repo = this.deps.rewardsRepository;
        const account = await repo.lockAccount(tx, due.userId);
        const lot = await repo.lockLot(tx, due.id);
        if (
          lot?.status !== 'AVAILABLE' ||
          lot.remainingPts === 0n ||
          lot.expiresAt.getTime() > Date.now()
        )
          return false;
        const journal = await this.move(tx, account, {
          key: `expire:${lot.id}`,
          userId: lot.userId,
          kind: 'EXPIRE',
          points: lot.remainingPts,
          dAvailable: -lot.remainingPts,
          dPending: 0n,
          dDebt: 0n,
          counterparty: 'POINTS_EXPIRED',
          title: 'Points expired',
          refType: lot.sourceType,
          refId: lot.sourceRef,
        });
        if (journal === null) return false;
        await repo.insertConsumptions(tx, [
          { id: uuidv7(), lotId: lot.id, journalId: journal.id, points: lot.remainingPts },
        ]);
        await repo.updateLot(tx, lot.id, { status: 'EXPIRED', remainingPts: 0n });
        return true;
      });
      if (done) expired += 1;
    }
    return { expired };
  }

  /** "Points expiring soon" (once per lot) → points.expiring_soon.v1 for notifications. */
  async noticeDue(): Promise<{ noticed: number }> {
    const s = await this.deps.settingsService.current();
    const until = addDays(new Date(), s.pointsExpiryNoticeDays);
    let noticed = 0;
    for (const due of await this.deps.rewardsRepository.dueForNotice(until, JOB_BATCH)) {
      await this.deps.runInTransaction(async (tx) => {
        const lot = await this.deps.rewardsRepository.lockLot(tx, due.id);
        if (lot?.status !== 'AVAILABLE' || lot.expiryNoticeAt !== null) return;
        await this.deps.rewardsRepository.updateLot(tx, lot.id, { expiryNoticeAt: new Date() });
        await emitWalletEvent(
          tx,
          WALLET_EVENTS.pointsExpiringSoon,
          {
            userId: lot.userId,
            points: Number(lot.remainingPts),
            expiresAt: lot.expiresAt.toISOString(),
          },
          `expiry-notice:${lot.id}`,
        );
        noticed += 1;
      });
    }
    return { noticed };
  }

  // ── Reads ──

  async summary(userId: string): Promise<RewardsSummary> {
    const s = await this.deps.settingsService.current();
    const repo = this.deps.rewardsRepository;
    const account = await repo.accountOf(userId);
    const soon = await repo.expiring(userId, addDays(new Date(), EXPIRING_WINDOW_DAYS));
    const available = account?.availablePts ?? 0n;
    const value = available * BigInt(s.pointValuePaise);
    return {
      availablePts: Number(available),
      valuePaise: Number(value),
      value: rupees(value),
      pendingPts: Number(account?.pendingPts ?? 0n),
      debtPts: Number(account?.debtPts ?? 0n),
      lifetimeEarned: Number(account?.lifetimeEarned ?? 0n),
      expiringSoon: {
        points: Number(soon.points),
        firstExpiresAt: soon.first,
        withinDays: EXPIRING_WINDOW_DAYS,
      },
      conversion: {
        pointValuePaise: s.pointValuePaise,
        minPoints: s.pointsMinConvert,
        stepPoints: s.pointsConvertStep,
        eligible: available >= BigInt(s.pointsMinConvert),
      },
    };
  }

  /** Points statement data, oldest first (max `limit` rows). */
  async statement(userId: string, from: Date, to: Date, limit: number) {
    const repo = this.deps.rewardsRepository;
    const rows = await repo.journalsBetween(userId, from, to, limit + 1);
    return {
      opening: await repo.availableAt(userId, from),
      closing: await repo.availableAt(userId, to),
      rows: rows.slice(0, limit).map(toEntryView),
      truncated: rows.length > limit,
    };
  }

  /** Reconciliation findings (ledger-check job). */
  mismatches() {
    return this.deps.rewardsRepository.mismatches();
  }

  async ledger(
    userId: string,
    q: { cursor?: string; limit: number },
  ): Promise<Paginated<PointsEntryView>> {
    const page = await this.deps.rewardsRepository.journals(userId, q);
    return { ...page, items: page.items.map(toEntryView) };
  }

  // ── Core ──

  /**
   * One journal + postings + bucket update under the account lock the caller holds. Returns null
   * when the key was already used (a replay: nothing moves). A bucket below 0 is a bug → 500.
   */
  private async move(
    tx: Tx,
    account: PointsAccountRow,
    m: PointsMove,
  ): Promise<PointsJournalRow | null> {
    const repo = this.deps.rewardsRepository;
    if ((await repo.journalByKey(tx, m.key)) !== null) return null;
    const next = {
      availablePts: account.availablePts + m.dAvailable,
      pendingPts: account.pendingPts + m.dPending,
      debtPts: account.debtPts + m.dDebt,
      lifetimeEarned: account.lifetimeEarned + (m.earned ?? 0n),
    };
    if (next.availablePts < 0n || next.pendingPts < 0n || next.debtPts < 0n)
      throw new InternalError(`points move ${m.kind} would make a bucket negative`);

    let journal: PointsJournalRow | null = null;
    for (let attempt = 0; journal === null && attempt < 3; attempt += 1) {
      journal = await repo.insertJournal(tx, {
        id: uuidv7(),
        journalNo: newPointsNo(),
        kind: m.kind,
        idempotencyKey: m.key,
        userId: m.userId,
        points: m.points,
        deltaPts: m.dAvailable + m.dPending - m.dDebt,
        refType: m.refType ?? null,
        refId: m.refId ?? null,
        title: m.title,
        subtitle: m.subtitle ?? null,
        ...(m.metadata == null ? {} : { metadata: m.metadata as object }),
        availableAfter: next.availablePts,
        pendingAfter: next.pendingPts,
        debtAfter: next.debtPts,
        createdBy: m.createdBy ?? null,
      });
      if (journal === null && (await repo.journalByKey(tx, m.key)) !== null) return null;
    }
    if (journal === null) throw new InternalError('points: could not allocate a journal number');

    const postings: {
      id: string;
      journalId: string;
      accountId: string;
      bucket: 'AVAILABLE' | 'PENDING' | 'DEBT' | 'SYSTEM';
      points: bigint;
    }[] = [
      { bucket: 'AVAILABLE' as const, points: m.dAvailable },
      { bucket: 'PENDING' as const, points: m.dPending },
      // DEBT is a negative bucket: owing more points is a negative posting.
      { bucket: 'DEBT' as const, points: -m.dDebt },
    ]
      .filter((p) => p.points !== 0n)
      .map((p) => ({ id: uuidv7(), journalId: journal.id, accountId: account.id, ...p }));
    const userSum = m.dAvailable + m.dPending - m.dDebt;
    if (userSum !== 0n) {
      if (m.counterparty === null) throw new InternalError('points move without a counterparty');
      postings.push({
        id: uuidv7(),
        journalId: journal.id,
        accountId: await this.systemAccount(tx, m.counterparty),
        bucket: 'SYSTEM',
        points: -userSum,
      });
    }
    await repo.insertPostings(tx, postings);
    await repo.setBuckets(tx, account.id, next);
    Object.assign(account, next);
    await emitWalletEvent(
      tx,
      WALLET_EVENTS.pointsPosted,
      {
        journalId: journal.id,
        journalNo: journal.journalNo,
        userId: m.userId,
        kind: m.kind,
        deltaPts: Number(journal.deltaPts),
        availableAfter: Number(next.availablePts),
        pendingAfter: Number(next.pendingPts),
        refType: journal.refType,
        refId: journal.refId,
      },
      m.correlationId ?? journal.id,
    );
    return journal;
  }

  /** Takes points from lots (FIFO plan) and records each take; emptied lots become EXHAUSTED. */
  private async consume(
    tx: Tx,
    takes: { lotId: string; points: bigint }[],
    journalId: string,
    skipStatusFor?: string,
  ): Promise<void> {
    const repo = this.deps.rewardsRepository;
    await repo.insertConsumptions(
      tx,
      takes.map((t) => ({ id: uuidv7(), lotId: t.lotId, journalId, points: t.points })),
    );
    for (const t of takes) {
      if (t.lotId === skipStatusFor) continue; // the caller updates that lot itself
      const lot = await repo.lockLot(tx, t.lotId);
      if (lot === null) continue;
      const remaining = lot.remainingPts - t.points;
      await repo.updateLot(tx, lot.id, {
        remainingPts: remaining,
        ...(remaining === 0n ? { status: 'EXHAUSTED' as const } : {}),
      });
    }
  }

  private async systemAccount(tx: Tx, code: PointsSystemCode): Promise<string> {
    this.system ??= await this.deps.rewardsRepository.systemAccounts(tx);
    const id = this.system.get(code);
    if (id === undefined) throw new InternalError(`points system account ${code} is missing`);
    return id;
  }
}
