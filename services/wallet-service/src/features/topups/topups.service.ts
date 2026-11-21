import { randomBytes } from 'node:crypto';

import { AppError, ErrorCode, NotFoundError } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import { type Tx, advisoryXactLock } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { PaymentRefusal, type PaymentState } from '../../adapters/payment-client.js';
import { uuidv7 } from '../../adapters/uuid.js';
import { rupees } from '../ledger/index.js';
import {
  type CheckoutPayload,
  type CreateTopupInput,
  OPEN_TOPUP,
  PREFILL,
  type PaymentOutcome,
  type TopupRow,
  type TopupView,
  cashbackFor,
  instrumentLabel,
  istDayStart,
  outcomeState,
  toTopupView,
} from './topups.types.js';

type Deps = Pick<
  Cradle,
  | 'topupsRepository'
  | 'runInTransaction'
  | 'ledgerService'
  | 'settingsService'
  | 'paymentClient'
  | 'rewardsService'
  | 'logger'
>;

const JOB_BATCH = 50;
/** An open top-up older than this is re-checked by the job (lost event / crash guard). */
const RECONCILE_AFTER_MS = 2 * 60_000;
/** GET re-checks the gateway only for a top-up older than this (the app polls right after paying). */
const LIVE_CHECK_AFTER_MS = 3_000;

const yymmdd = (d = new Date()) => d.toISOString().slice(2, 10).replaceAll('-', '');
export const newTopupNo = () => `TU-${yymmdd()}-${randomBytes(4).toString('hex').toUpperCase()}`;

const refuse = (message: string, reason: string, extra: object = {}) =>
  new AppError(ErrorCode.VALIDATION_ERROR, message, 422, { details: { reason, ...extra } });

/** Serialises one customer's top-up starts and completions (limits, first-top-up cashback). */
const userLock = (tx: Tx, userId: string) => advisoryXactLock(tx, `wallet-topup:${userId}`);

export const fromPaymentState = (p: PaymentState): PaymentOutcome => ({
  paymentId: p.id,
  paymentNo: p.paymentNo,
  referenceId: p.referenceId,
  state: outcomeState(p.status),
  capturedPaise: p.capturedPaise,
  method: p.method,
  bank: p.bank,
  cardLast4: p.cardLast4,
  cardNetwork: p.cardNetwork,
  vpaMasked: p.vpaMasked,
  failureCode: p.failureCode,
  failureReason: p.failureReason,
  source: 'live',
});

/**
 * Add Money (D-54). The client never sends a balance or a status: the wallet is credited only
 * from payment-service's view of the gateway, once (ledger key topup:<id>), whichever of the
 * event, the live check or the reconcile job sees the capture first.
 *
 *   CREATED ──payment created──▶ PENDING ──attempt failed──▶ FAILED (retry allowed)
 *      │                            │  ▲───────────────────────┘
 *      └──────────┬─────────────────┴──captured──▶ COMPLETED (credited)
 *                 └──not paid in time──▶ EXPIRED ──late capture──▶ COMPLETED
 */
export class TopupsService {
  constructor(private readonly deps: Deps) {}

  // ── Customer ──

  async options(user: AuthUser) {
    const s = await this.deps.settingsService.current();
    const { balance, today, firstTopup } = await this.deps.runInTransaction(async (tx) => ({
      balance: await this.deps.ledgerService.balanceInTx(tx, user.id),
      today: await this.deps.topupsRepository.startedSince(tx, user.id, istDayStart()),
      firstTopup: !(await this.deps.topupsRepository.hasCompletedOther(tx, user.id)),
    }));
    const cb = s.firstTopupCashback;
    const maxBy = (a: bigint, b: bigint) => (a < b ? a : b);
    const room = maxBy(BigInt(s.maxBalancePaise) - balance, BigInt(s.topupDailyMaxPaise) - today);
    return {
      balancePaise: Number(balance),
      balance: rupees(balance),
      minPaise: s.topupMinPaise,
      maxPaise: s.topupMaxPaise,
      /** The most this customer can add right now (balance cap and today's limit). */
      availablePaise: Number(room < 0n ? 0n : maxBy(room, BigInt(s.topupMaxPaise))),
      maxBalancePaise: s.maxBalancePaise,
      dailyMaxPaise: s.topupDailyMaxPaise,
      presetsPaise: s.topupPresetsPaise,
      methods: [
        { method: 'UPI', label: 'UPI', hint: 'GPay, PhonePe, Paytm' },
        { method: 'NETBANKING', label: 'Net Banking', hint: 'All major banks' },
        { method: 'CARD', label: 'Debit / Credit Card', hint: 'Visa, Mastercard, RuPay' },
      ],
      cashbackOffer:
        cb.enabled && cb.percentBps > 0 && cb.maxPaise > 0
          ? {
              eligible: firstTopup,
              method: cb.method.toUpperCase(),
              percent: (cb.percentBps / 100).toFixed(2).replace(/\.?0+$/, ''),
              maxPaise: cb.maxPaise,
              paidAs: 'REWARD_POINTS',
              pointValuePaise: s.pointValuePaise,
            }
          : null,
    };
  }

  /**
   * Starts (or resumes, same Idempotency-Key) a top-up and returns the gateway checkout. Limits
   * are checked under a per-customer lock, so parallel requests cannot exceed them together.
   */
  async create(
    user: AuthUser,
    idempotencyKey: string,
    hash: string,
    input: CreateTopupInput,
  ): Promise<{ topup: TopupView; checkout: CheckoutPayload | null }> {
    const s = await this.deps.settingsService.current();
    if (input.amountPaise < s.topupMinPaise || input.amountPaise > s.topupMaxPaise)
      throw refuse(
        `Add between ₹${rupees(BigInt(s.topupMinPaise))} and ₹${rupees(BigInt(s.topupMaxPaise))}`,
        'AMOUNT_OUT_OF_RANGE',
        { minPaise: s.topupMinPaise, maxPaise: s.topupMaxPaise },
      );
    const amount = BigInt(input.amountPaise);

    let topup = await this.deps.runInTransaction(async (tx) => {
      await userLock(tx, user.id);
      const repo = this.deps.topupsRepository;
      const existing = await repo.byKey(tx, user.id, idempotencyKey);
      if (existing !== null) {
        if (existing.requestHash !== hash)
          throw refuse(
            'This Idempotency-Key was used for a different top-up',
            'IDEMPOTENCY_KEY_REUSED',
          );
        return existing;
      }
      const balance = await this.deps.ledgerService.balanceInTx(tx, user.id);
      if (balance + amount > BigInt(s.maxBalancePaise))
        throw refuse('This top-up would take your wallet above its limit', 'MAX_BALANCE_EXCEEDED', {
          maxBalancePaise: s.maxBalancePaise,
          balancePaise: Number(balance),
          availablePaise: Number(BigInt(s.maxBalancePaise) - balance),
        });
      const today = await repo.startedSince(tx, user.id, istDayStart());
      if (today + amount > BigInt(s.topupDailyMaxPaise))
        throw refuse("Today's top-up limit is reached", 'DAILY_LIMIT_EXCEEDED', {
          dailyMaxPaise: s.topupDailyMaxPaise,
          remainingPaise: Number(BigInt(s.topupDailyMaxPaise) - today),
        });
      return repo.insert(tx, {
        id: uuidv7(),
        topupNo: newTopupNo(),
        userId: user.id,
        amountPaise: amount,
        method: input.method,
        idempotencyKey,
        requestHash: hash,
        expiresAt: new Date(Date.now() + s.topupWindowMinutes * 60_000),
      });
    });

    if (!OPEN_TOPUP.includes(topup.status)) return { topup: toTopupView(topup), checkout: null };
    const checkout = await this.ensurePayment(topup);
    topup = (await this.deps.topupsRepository.find(topup.id)) ?? topup;
    return {
      topup: toTopupView(topup),
      checkout: {
        paymentId: checkout.paymentId,
        paymentNo: checkout.paymentNo,
        provider: checkout.provider,
        keyId: checkout.keyId,
        providerOrderId: checkout.providerOrderId,
        amountPaise: checkout.amountPaise,
        currency: checkout.currency,
        expiresAt: checkout.expiresAt,
        preferredMethod: PREFILL[topup.method],
      },
    };
  }

  /** Own top-up; an open one older than a few seconds is re-checked with the gateway first. */
  async get(user: AuthUser, id: string): Promise<TopupView> {
    let t = await this.deps.topupsRepository.find(id);
    // Someone else's top-up answers exactly like a missing one (no existence leak).
    if (t?.userId !== user.id) throw new NotFoundError('Top-up');
    if (
      OPEN_TOPUP.includes(t.status) &&
      t.paymentId !== null &&
      Date.now() - t.createdAt.getTime() > LIVE_CHECK_AFTER_MS
    ) {
      try {
        const live = await this.deps.paymentClient.liveStatus(t.paymentId);
        t = await this.deps.runInTransaction((tx) =>
          this.applyInTx(tx, t?.id ?? id, fromPaymentState(live)),
        );
      } catch (err) {
        // A read never fails because payments are slow: the job / event finishes it.
        this.deps.logger.warn({ err, topupId: id }, 'top-up live check failed');
      }
    }
    return toTopupView(t);
  }

  // ── Outcome (event, live check, job) ──

  /**
   * Applies one payment outcome under the top-up row lock. Idempotent: a capture credits once
   * (COMPLETED + ledger key), repeats and stale outcomes change nothing.
   */
  async applyInTx(tx: Tx, topupId: string, o: PaymentOutcome): Promise<TopupRow> {
    const repo = this.deps.topupsRepository;
    const t = await repo.lock(tx, topupId);
    if (t === null) throw new NotFoundError('Top-up');
    if (o.referenceId !== t.id || (t.paymentId !== null && t.paymentId !== o.paymentId)) {
      this.deps.logger.error(
        { topupId, paymentId: o.paymentId, referenceId: o.referenceId },
        'payment outcome does not belong to this top-up; ignored',
      );
      return t;
    }
    if (t.status === 'COMPLETED') return t;
    const link = t.paymentId === null ? { paymentId: o.paymentId, paymentNo: o.paymentNo } : {};

    switch (o.state) {
      case 'CAPTURED':
        return this.completeInTx(tx, t, o);
      case 'FAILED': {
        if (t.status === 'EXPIRED') return t;
        const counts = o.source === 'event' || t.status !== 'FAILED';
        return repo.update(tx, t.id, {
          ...link,
          status: 'FAILED',
          failureCode: o.failureCode?.slice(0, 60) ?? null,
          failureReason: o.failureReason?.slice(0, 300) ?? null,
          lastFailedAt: new Date(),
          ...(counts ? { failedAttempts: { increment: 1 } } : {}),
        });
      }
      case 'EXPIRED':
        if (t.status === 'EXPIRED') return t;
        return repo.update(tx, t.id, { ...link, status: 'EXPIRED', expiredAt: new Date() });
      case 'OPEN':
        return t.status === 'CREATED' ? repo.update(tx, t.id, { ...link, status: 'PENDING' }) : t;
    }
  }

  private async completeInTx(tx: Tx, t: TopupRow, o: PaymentOutcome): Promise<TopupRow> {
    await userLock(tx, t.userId);
    const credited = BigInt(o.capturedPaise);
    if (credited <= 0n) {
      this.deps.logger.error({ topupId: t.id, o }, 'captured top-up without an amount; ignored');
      return t;
    }
    if (credited !== t.amountPaise)
      this.deps.logger.error(
        { topupId: t.id, expected: Number(t.amountPaise), captured: o.capturedPaise },
        'captured amount differs from the top-up; crediting what was captured',
      );

    const s = await this.deps.settingsService.current(tx);
    const rule = s.firstTopupCashback;
    const cashback =
      rule.enabled &&
      o.method === rule.method &&
      !(await this.deps.topupsRepository.hasCompletedOther(tx, t.userId, t.id))
        ? cashbackFor(credited, rule, s.pointValuePaise)
        : { paise: 0n, points: 0 };

    // Points before money: the same lock order (points account → wallet account) as conversion.
    if (cashback.points > 0)
      await this.deps.rewardsService.grantCashbackInTx(tx, {
        topupId: t.id,
        topupNo: t.topupNo,
        userId: t.userId,
        points: cashback.points,
        basePaise: credited,
      });
    const instrument = instrumentLabel({ paidMethod: o.method, ...o });
    const posted = await this.deps.ledgerService.post(tx, {
      idempotencyKey: `topup:${t.id}`,
      userId: t.userId,
      kind: 'TOPUP',
      category: 'TOPUPS',
      direction: 'CREDIT',
      amountPaise: credited,
      counterparty: 'GATEWAY_CLEARING',
      title: 'Wallet Money Added',
      subtitle: instrument === null ? t.topupNo : `${instrument} · ${t.topupNo}`,
      refType: 'TOPUP',
      refId: t.id,
      metadata: {
        topupNo: t.topupNo,
        paymentId: o.paymentId,
        paymentNo: o.paymentNo,
        cashbackPoints: cashback.points,
      },
      correlationId: `topup:${t.id}`,
    });
    return this.deps.topupsRepository.update(tx, t.id, {
      status: 'COMPLETED',
      paymentId: o.paymentId,
      paymentNo: o.paymentNo ?? t.paymentNo,
      creditedPaise: credited,
      paidMethod: o.method,
      bank: o.bank,
      cardLast4: o.cardLast4,
      cardNetwork: o.cardNetwork,
      vpaMasked: o.vpaMasked,
      cashbackPaise: cashback.paise,
      cashbackPoints: cashback.points,
      cashbackGrantedAt: cashback.points > 0 ? new Date() : null,
      journalId: posted.journal.id,
      balanceAfterPaise: posted.balanceAfterPaise,
      completedAt: new Date(),
    });
  }

  /**
   * Creates (or re-reads — idempotent per top-up) the payment and links it. A CREATED top-up whose
   * payment can no longer be made (window over, nothing paid) becomes EXPIRED.
   */
  private async ensurePayment(t: TopupRow) {
    let checkout;
    try {
      checkout = await this.deps.paymentClient.createTopupPayment({
        topupId: t.id,
        topupNo: t.topupNo,
        userId: t.userId,
        amountPaise: Number(t.amountPaise),
        expiresAt: t.expiresAt,
      });
    } catch (err) {
      if (err instanceof PaymentRefusal) {
        if (err.status === 422 && t.paymentId === null && t.expiresAt.getTime() <= Date.now())
          await this.deps.runInTransaction(async (tx) => {
            const locked = await this.deps.topupsRepository.lock(tx, t.id);
            if (locked?.status === 'CREATED' && locked.paymentId === null)
              await this.deps.topupsRepository.update(tx, t.id, {
                status: 'EXPIRED',
                expiredAt: new Date(),
              });
          });
        throw err.toAppError();
      }
      throw err;
    }
    if (t.paymentId === null)
      await this.deps.runInTransaction(async (tx) => {
        const locked = await this.deps.topupsRepository.lock(tx, t.id);
        if (locked !== null && locked.paymentId === null)
          await this.deps.topupsRepository.update(tx, t.id, {
            paymentId: checkout.paymentId,
            paymentNo: checkout.paymentNo,
            ...(locked.status === 'CREATED' ? { status: 'PENDING' as const } : {}),
          });
      });
    return checkout;
  }

  // ── Jobs ──

  /** Completed top-ups of the last `hours` (ledger check). */
  completedSince(since: Date, limit: number): Promise<TopupRow[]> {
    return this.deps.topupsRepository.completedSince(since, limit);
  }

  /** Credits cashback points decided before the points ledger existed (or after a crash). */
  async grantPendingCashback(): Promise<{ granted: number }> {
    let granted = 0;
    for (const due of await this.deps.topupsRepository.ungrantedCashback(JOB_BATCH)) {
      await this.deps.runInTransaction(async (tx) => {
        const t = await this.deps.topupsRepository.lock(tx, due.id);
        if (t?.status !== 'COMPLETED' || t.cashbackPoints === 0 || t.cashbackGrantedAt !== null)
          return;
        await this.deps.rewardsService.grantCashbackInTx(tx, {
          topupId: t.id,
          topupNo: t.topupNo,
          userId: t.userId,
          points: t.cashbackPoints,
          basePaise: t.creditedPaise ?? t.amountPaise,
        });
        await this.deps.topupsRepository.update(tx, t.id, { cashbackGrantedAt: new Date() });
        granted += 1;
      });
    }
    return { granted };
  }

  /** Open top-ups older than 2 min: resume the payment, then re-read it (lost event guard). */
  async reconcile(): Promise<{ checked: number }> {
    const due = await this.deps.topupsRepository.openOlderThan(
      new Date(Date.now() - RECONCILE_AFTER_MS),
      JOB_BATCH,
    );
    for (const t of due) {
      try {
        const paymentId = t.paymentId ?? (await this.ensurePayment(t)).paymentId;
        const live = await this.deps.paymentClient.liveStatus(paymentId);
        await this.deps.runInTransaction((tx) => this.applyInTx(tx, t.id, fromPaymentState(live)));
      } catch (err) {
        this.deps.logger.warn({ err, topupId: t.id }, 'top-up reconcile failed; next run retries');
      }
      await this.deps.topupsRepository.touch(t.id).catch(() => undefined);
    }
    return { checked: due.length };
  }
}
