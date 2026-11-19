import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { type Tx, advisoryXactLock, isUniqueViolation } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import { type PromoDef, conditionsOf, toBasisPoints, toPaise } from '../pricing/index.js';
import {
  canTransition,
  liveEditIssues,
  normalizeCode,
  overlapping,
  promotionIssues,
} from './promotions.rules.js';
import type {
  CreatePromotionInput,
  PromoStatus,
  PromotionFields,
  PromotionListQuery,
  PromotionRecord,
  PromotionView,
  RedemptionView,
  RuleInput,
  StatusInput,
  UpdatePromotionInput,
} from './promotions.types.js';

type Rec = PromotionRecord & { rules: RuleInput[] };
type Deps = Pick<Cradle, 'promotionsRepository' | 'auditService' | 'runInTransaction'>;

const DEFAULTS: Omit<PromotionFields, 'title' | 'kind' | 'benefitType' | 'startAt' | 'endAt'> = {
  code: null,
  subtitle: null,
  termsText: null,
  badgeText: null,
  flatAmount: null,
  percentage: null,
  maxDiscountAmount: null,
  comboBuyQty: null,
  comboGetQty: null,
  comboGetPercent: null,
  bundlePrice: null,
  freeShipping: false,
  scope: 'PLATFORM_WIDE',
  minOrderAmount: 0,
  isAutoApply: false,
  isStackable: false,
  priority: 0,
  totalUsageLimit: null,
  perFarmLimit: null,
  perUserLimit: null,
  accountType: 'ALL',
  farmHistory: 'ALL',
  paymentMethod: 'ANY',
  isMemberOnly: false,
  isPublic: false,
  targets: [],
  rules: [],
};

const num = (v: string | null) => (v === null ? null : Number(v));

/** Record → editable fields (to merge a patch and re-validate the whole promotion). */
const fieldsOf = (r: Rec): PromotionFields => ({
  code: r.code,
  title: r.title,
  subtitle: r.subtitle,
  termsText: r.termsText,
  badgeText: r.badgeText,
  kind: r.kind,
  benefitType: r.benefitType,
  flatAmount: num(r.flatAmount),
  percentage: num(r.percentage),
  maxDiscountAmount: num(r.maxDiscountAmount),
  comboBuyQty: r.comboBuyQty,
  comboGetQty: r.comboGetQty,
  comboGetPercent: num(r.comboGetPercent),
  bundlePrice: num(r.bundlePrice),
  freeShipping: r.freeShipping,
  scope: r.scope,
  minOrderAmount: Number(r.minOrderAmount),
  startAt: r.startAt,
  endAt: r.endAt,
  isAutoApply: r.isAutoApply,
  isStackable: r.isStackable,
  priority: r.priority,
  totalUsageLimit: r.totalUsageLimit,
  perFarmLimit: r.perFarmLimit,
  perUserLimit: r.perUserLimit,
  accountType: r.accountType,
  farmHistory: r.farmHistory,
  paymentMethod: r.paymentMethod,
  isMemberOnly: r.isMemberOnly,
  isPublic: r.isPublic,
  targets: r.targets,
  rules: r.rules,
});

export const toView = (r: Rec, now: Date = new Date()): PromotionView => ({
  id: r.id,
  code: r.code,
  title: r.title,
  subtitle: r.subtitle,
  termsText: r.termsText,
  badgeText: r.badgeText,
  kind: r.kind,
  benefitType: r.benefitType,
  flatAmount: r.flatAmount,
  percentage: r.percentage,
  maxDiscountAmount: r.maxDiscountAmount,
  comboBuyQty: r.comboBuyQty,
  comboGetQty: r.comboGetQty,
  comboGetPercent: r.comboGetPercent,
  bundlePrice: r.bundlePrice,
  freeShipping: r.freeShipping,
  scope: r.scope,
  targets: r.targets,
  rules: r.rules,
  minOrderAmount: r.minOrderAmount,
  startAt: r.startAt.toISOString(),
  endAt: r.endAt.toISOString(),
  status: r.status,
  effectiveStatus:
    r.status !== 'ACTIVE'
      ? r.status
      : now >= r.endAt
        ? 'EXPIRED'
        : now < r.startAt
          ? 'SCHEDULED'
          : 'ACTIVE',
  statusChangedAt: r.statusChangedAt.toISOString(),
  statusReason: r.statusReason,
  isAutoApply: r.isAutoApply,
  isStackable: r.isStackable,
  priority: r.priority,
  accountType: r.accountType,
  farmHistory: r.farmHistory,
  paymentMethod: r.paymentMethod,
  isMemberOnly: r.isMemberOnly,
  isPublic: r.isPublic,
  limits: {
    totalUsageLimit: r.totalUsageLimit,
    perFarmLimit: r.perFarmLimit,
    perUserLimit: r.perUserLimit,
  },
  usage: {
    usedCount: r.usedCount,
    remaining: r.totalUsageLimit === null ? null : Math.max(0, r.totalUsageLimit - r.usedCount),
  },
  version: r.version,
  createdByUserId: r.createdByUserId,
  updatedByUserId: r.updatedByUserId,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** Record → the pricing engine's input (paise / basis points). */
export const toPromoDef = (r: Rec): PromoDef => {
  const p = (v: string | null) => (v === null ? null : toPaise(v));
  const bp = (v: string | null) => (v === null ? null : toBasisPoints(v));
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    subtitle: r.subtitle,
    badgeText: r.badgeText,
    kind: r.kind,
    benefitType: r.benefitType,
    flatAmount: p(r.flatAmount),
    percentage: bp(r.percentage),
    maxDiscountAmount: p(r.maxDiscountAmount),
    comboBuyQty: r.comboBuyQty,
    comboGetQty: r.comboGetQty,
    comboGetPercent: bp(r.comboGetPercent),
    bundlePrice: p(r.bundlePrice),
    freeShipping: r.freeShipping,
    scope: r.scope,
    targets: r.targets,
    rules: r.rules,
    minOrderAmount: toPaise(r.minOrderAmount),
    startAt: r.startAt,
    endAt: r.endAt,
    status: r.status,
    isAutoApply: r.isAutoApply,
    isStackable: r.isStackable,
    priority: r.priority,
    totalUsageLimit: r.totalUsageLimit,
    perFarmLimit: r.perFarmLimit,
    perUserLimit: r.perUserLimit,
    usedCount: r.usedCount,
    accountType: r.accountType,
    farmHistory: r.farmHistory,
    paymentMethod: r.paymentMethod,
    isMemberOnly: r.isMemberOnly,
  };
};

const invalid = (issues: ReturnType<typeof promotionIssues>) =>
  new ValidationError(issues, 'Promotion is not valid');
const versionConflict = (current: number) =>
  new ConflictError('The promotion was changed by someone else; reload and retry', {
    details: { reason: 'VERSION_CONFLICT', currentVersion: current },
  });
const stateInvalid = (from: PromoStatus, to?: PromoStatus) =>
  new ConflictError(
    to === undefined
      ? `A ${from} promotion cannot be edited`
      : `Cannot move a ${from} promotion to ${to}`,
    {
      details: { reason: 'PROMO_STATE_INVALID', from, ...(to === undefined ? {} : { to }) },
    },
  );

/** Admin rules for promotions + the read API the offers feature uses. */
export class PromotionsService {
  constructor(private readonly deps: Deps) {}

  async list(query: PromotionListQuery): Promise<Paginated<PromotionView>> {
    const page = await this.deps.promotionsRepository.list(query);
    const now = new Date();
    return { ...page, items: page.items.map((r) => toView(r, now)) };
  }

  async get(id: string): Promise<PromotionView> {
    return toView(await this.mustFind(id));
  }

  /** Created as DRAFT; must already be consistent [R6]. */
  async create(actor: Actor, input: CreatePromotionInput): Promise<PromotionView> {
    const { reason, ...rest } = input;
    const fields: PromotionFields = { ...DEFAULTS, ...rest, code: normalizeCode(rest.code) };
    const issues = promotionIssues(fields);
    if (issues.length > 0) throw invalid(issues);
    const id = await this.write(fields.code, async (tx) => {
      const newId = await this.deps.promotionsRepository.create(tx, fields, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'promotion.create',
        targetType: 'promotion',
        targetId: newId,
        after: { ...fields },
        reason: reason ?? null,
      });
      return newId;
    });
    return this.get(id);
  }

  async update(actor: Actor, id: string, input: UpdatePromotionInput): Promise<PromotionView> {
    const { version, reason, ...patch } = input;
    if (patch.code !== undefined) patch.code = normalizeCode(patch.code);
    await this.write(patch.code ?? null, async (tx) => {
      const current = await this.mustFind(id, tx);
      if (current.version !== version) throw versionConflict(current.version);
      if (current.status === 'ARCHIVED') throw stateInvalid(current.status);
      const live = current.status !== 'DRAFT';
      if (live) {
        const issues = liveEditIssues(current, patch);
        if (issues.length > 0) throw invalid(issues);
      }
      const merged = { ...fieldsOf(current), ...patch };
      const issues = promotionIssues(merged, live ? new Date() : undefined);
      if (issues.length > 0) throw invalid(issues);
      const ok = await this.deps.promotionsRepository.update(tx, id, version, patch, actor.userId);
      if (!ok) throw versionConflict(current.version);
      await this.deps.auditService.record(tx, actor, {
        action: 'promotion.update',
        targetType: 'promotion',
        targetId: id,
        before: Object.fromEntries(
          Object.keys(patch).map((k) => [
            k,
            (fieldsOf(current) as unknown as Record<string, unknown>)[k],
          ]),
        ),
        after: patch,
        reason: reason ?? null,
      });
    });
    return this.get(id);
  }

  /** State machine + activation checks + overlap check, serialised by an advisory lock [R6]. */
  async changeStatus(actor: Actor, id: string, input: StatusInput): Promise<PromotionView> {
    await this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, 'order.promotions.status');
      const current = await this.mustFind(id, tx);
      if (current.status === input.to || !canTransition(current.status, input.to))
        throw stateInvalid(current.status, input.to);
      if (input.to === 'ACTIVE') {
        const now = new Date();
        const issues = promotionIssues(fieldsOf(current), now);
        if (issues.length > 0) throw invalid(issues);
        if (current.kind === 'LINE_OFFER' || current.kind === 'AUTO_BONUS') {
          const others = await this.deps.promotionsRepository.liveOfKind(tx, current.kind, now);
          const conflicts = overlapping(current, others);
          if (conflicts.length > 0)
            throw new ConflictError('Another live promotion overlaps this one', {
              details: { reason: 'PROMO_OVERLAP', conflictingIds: conflicts },
            });
        }
      }
      const ok = await this.deps.promotionsRepository.setStatus(
        tx,
        id,
        current.version,
        input.to,
        input.reason,
        actor.userId,
      );
      if (!ok) throw versionConflict(current.version);
      await this.deps.auditService.record(tx, actor, {
        action: 'promotion.status',
        targetType: 'promotion',
        targetId: id,
        before: { status: current.status },
        after: { status: input.to },
        reason: input.reason,
      });
    });
    return this.get(id);
  }

  async redemptions(
    id: string,
    query: { cursor?: string; limit: number },
  ): Promise<Paginated<RedemptionView>> {
    await this.mustFind(id);
    return this.deps.promotionsRepository.redemptions(id, query);
  }

  // ── Read API for the offers feature ──

  /**
   * Public offers page (no login): ACTIVE promotions flagged `isPublic`, inside their window;
   * optionally only those valid for a category (platform-wide or targeting it). Never limits,
   * usage, rules or targets — only what a shopper needs to read.
   */
  async publicList(now: Date, categoryId?: string) {
    const rows = (await this.deps.promotionsRepository.activeAt(now)).filter(
      (r) =>
        r.isPublic &&
        (categoryId === undefined ||
          r.scope === 'PLATFORM_WIDE' ||
          r.targets.some((t) => t.targetType === 'CATEGORY' && t.targetId === categoryId)),
    );
    return rows
      .sort((a, b) => b.priority - a.priority || a.endAt.getTime() - b.endAt.getTime())
      .map((r) => ({
        promotionId: r.id,
        code: r.code,
        title: r.title,
        subtitle: r.subtitle,
        badgeText: r.badgeText,
        termsText: r.termsText,
        kind: r.kind,
        benefitType: r.benefitType,
        flatAmount: r.flatAmount,
        percentage: r.percentage,
        maxDiscountAmount: r.maxDiscountAmount,
        bundlePrice: r.bundlePrice,
        minOrderAmount: r.minOrderAmount,
        freeShipping: r.freeShipping,
        scope: r.scope,
        validUntil: r.endAt.toISOString(),
        conditions: conditionsOf(toPromoDef(r)),
      }));
  }

  async activeForPricing(now: Date): Promise<PromoDef[]> {
    return (await this.deps.promotionsRepository.activeAt(now)).map(toPromoDef);
  }

  usage(promotionIds: readonly string[], farmId: string, userId: string) {
    return this.deps.promotionsRepository.usage(promotionIds, farmId, userId);
  }

  /**
   * Checkout: re-checks every usage limit on FRESH data under the promotion row locks (the offers
   * shown before checkout are advisory, R7), then records the redemptions and bumps usedCount.
   */
  async redeemInTx(
    tx: Tx,
    o: {
      orderId: string;
      farmId: string;
      userId: string;
      redemptions: {
        promotionId: string;
        discountAmount: string;
        items: { orderItemId: string; quantity: number; discountAmount: string }[];
      }[];
    },
  ): Promise<void> {
    if (o.redemptions.length === 0) return;
    const repo = this.deps.promotionsRepository;
    const ids = o.redemptions.map((r) => r.promotionId);
    const limits = await repo.lockLimits(tx, ids);
    const counts = await repo.liveCounts(tx, ids, o.farmId, o.userId);
    for (const l of limits) {
      const used = counts.get(l.id) ?? { farm: 0, user: 0 };
      const exhausted =
        (l.totalUsageLimit !== null && l.usedCount >= l.totalUsageLimit) ||
        (l.perFarmLimit !== null && used.farm >= l.perFarmLimit) ||
        (l.perUserLimit !== null && used.user >= l.perUserLimit);
      if (exhausted)
        throw new ConflictError('An offer in your cart has just run out. Review the price and try again.', {
          details: { reason: 'PROMO_LIMIT_REACHED', promotionId: l.id },
        });
    }
    for (const r of o.redemptions)
      await repo.insertRedemption(tx, { ...r, orderId: o.orderId, farmId: o.farmId, userId: o.userId });
  }

  /** Gives an order's offers back (usedCount −1 each). */
  reverseInTx(tx: Tx, orderId: string): Promise<number> {
    return this.deps.promotionsRepository.reverseForOrder(tx, orderId);
  }

  farmOrderCount(farmId: string): Promise<number> {
    return this.deps.promotionsRepository.farmOrderCount(farmId);
  }

  // ── Helpers ──

  private async mustFind(id: string, tx?: Tx): Promise<Rec> {
    const row = await this.deps.promotionsRepository.findById(id, tx);
    if (row === null) throw new NotFoundError('Promotion');
    return row;
  }

  /** One transaction; the live-code unique index → 409 PROMO_CODE_TAKEN [R1]. */
  private async write<T>(code: string | null, work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.deps.runInTransaction(work);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError('A live promotion already uses this code', {
          details: { reason: 'PROMO_CODE_TAKEN', code },
        });
      throw error;
    }
  }
}
