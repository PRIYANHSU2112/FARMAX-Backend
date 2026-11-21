import { createHash } from 'node:crypto';

import { AppError, ErrorCode, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { callKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import { type Issue, checkAvailability, rankCandidates } from './experts.rules.js';
import type {
  AvailabilityInput,
  AvailabilityView,
  CreateExpertInput,
  ExpertCard,
  ExpertListQuery,
  ExpertPatch,
  ExpertView,
  HolidayInput,
  HolidayView,
  RecommendQuery,
  RecommendedView,
  TimeOffInput,
  TimeOffView,
  UpdateExpertInput,
  UpdateMyProfileInput,
} from './experts.types.js';

/** Presence key lifetime; the expert app heartbeats every 30 s. */
export const PRESENCE_TTL_SEC = 90;
const RECOMMEND_TTL_SEC = 30;
const MAX_TIME_OFF_DAYS = 90;

type Deps = Pick<
  Cradle,
  | 'expertsRepository'
  | 'runInTransaction'
  | 'auditService'
  | 'optionsService'
  | 'gens'
  | 'cache'
  | 'redis'
  | 'logger'
  | 'authDirectory'
  | 'productClient'
  | 'catalogClient'
  | 'farmClient'
>;

const conflict = (message: string, reason: string) =>
  new AppError(ErrorCode.CONFLICT, message, 409, { details: { reason } });

/** Business rules of a profile (shape is checked by Joi on the route). Pure. */
export const checkProfile = (
  p: Pick<ExpertView, 'type' | 'isBookable' | 'channels' | 'territoryCodes'>,
): void => {
  const issues: Issue[] = [];
  if (p.type === 'VET' && p.isBookable)
    issues.push({
      path: 'isBookable',
      message: 'VET profiles are recommendation-only and can never take sales-call bookings',
    });
  if (p.isBookable && p.channels.length === 0)
    issues.push({ path: 'channels', message: 'a bookable expert needs at least one channel' });
  if (p.channels.includes('FARM_VISIT') && p.territoryCodes.length === 0)
    issues.push({ path: 'territoryCodes', message: 'FARM_VISIT needs at least one territory' });
  if (issues.length > 0) throw new ValidationError(issues);
};

export const toCard = (e: ExpertView): ExpertCard => ({
  id: e.id,
  type: e.type,
  displayName: e.displayName,
  title: e.title,
  qualification: e.qualification,
  photoUrl: e.photoUrl,
  experienceYears: e.experienceYears,
  languages: e.languages,
  ratingAvg: e.ratingAvg,
  onTimePct: e.onTimePct,
});

/**
 * Experts (D-53): staff / vendor profiles that take sales calls (SALES_REP, SPECIALIST) or only
 * appear as the recommended-expert card (VET). Every change that can alter availability bumps
 * `poolGen` after commit; reassigning already-booked calls is done by the bookings lifecycle.
 */
export class ExpertsService {
  constructor(private readonly deps: Deps) {}

  activeIdOfUser(userId: string): Promise<string | null> {
    return this.deps.expertsRepository.activeIdOfUser(userId);
  }

  // ── admin: profiles ──

  list(query: ExpertListQuery): Promise<Paginated<ExpertView>> {
    return this.deps.expertsRepository.list(query);
  }

  async get(id: string): Promise<ExpertView & AvailabilityView> {
    const expert = await this.deps.expertsRepository.findById(id);
    if (expert === null) throw new NotFoundError('Expert');
    return { ...expert, ...(await this.deps.expertsRepository.availability(id)) };
  }

  async create(actor: Actor, input: CreateExpertInput): Promise<ExpertView> {
    const isBookable = input.isBookable ?? input.type !== 'VET';
    await this.checkLanguages(input.languages);
    checkProfile({ territoryCodes: [], ...input, isBookable });
    // Network check BEFORE the transaction (D-53).
    if (!(await this.deps.authDirectory.userExists(input.userId)))
      throw new ValidationError([{ path: 'userId', message: 'no such user' }]);
    const created = await this.deps.runInTransaction(async (tx) => {
      const row = await this.deps.expertsRepository.create(tx, { ...input, isBookable });
      await this.audit(tx, actor, 'expert.create', row.id, null, row);
      return row;
    });
    await this.deps.gens.bumpPool();
    return created;
  }

  async update(actor: Actor, id: string, input: UpdateExpertInput, ifMatch?: number): Promise<ExpertView> {
    const { reason, ...patch } = input;
    if (patch.languages !== undefined) await this.checkLanguages(patch.languages);
    const result = await this.deps.runInTransaction(async (tx) => {
      const before = await this.mustLock(tx, id, ifMatch);
      const merged = { ...before, ...patch };
      if (patch.type === 'VET' && patch.isBookable === undefined) merged.isBookable = false;
      checkProfile(merged);
      if ((patch.isActive === false && before.isActive) || (!merged.isBookable && before.isBookable)) {
        if (reason === undefined)
          throw new ValidationError([{ path: 'reason', message: 'reason is required to deactivate or stop bookings' }]);
      }
      const data: ExpertPatch = { ...patch, isBookable: merged.isBookable };
      const after = await this.deps.expertsRepository.update(tx, id, data);
      await this.audit(tx, actor, 'expert.update', id, before, after, reason);
      return after;
    });
    await this.deps.gens.bumpPool();
    return result;
  }

  // ── availability (admin or self) ──

  async availability(expertId: string): Promise<AvailabilityView> {
    if ((await this.deps.expertsRepository.findById(expertId)) === null) throw new NotFoundError('Expert');
    return this.deps.expertsRepository.availability(expertId);
  }

  async putAvailability(actor: Actor, expertId: string, input: AvailabilityInput): Promise<AvailabilityView> {
    const view = await this.deps.runInTransaction(async (tx) => {
      const expert = await this.mustLock(tx, expertId);
      const issues = checkAvailability(input, expert.channels);
      if (issues.length > 0) throw new ValidationError(issues);
      const before = await this.deps.expertsRepository.availability(expertId, tx);
      await this.deps.expertsRepository.replaceAvailability(tx, expertId, input);
      await this.deps.expertsRepository.update(tx, expertId, {});
      const after = await this.deps.expertsRepository.availability(expertId, tx);
      await this.audit(tx, actor, 'expert.availability', expertId, { ...before }, { ...after });
      return after;
    });
    await this.deps.gens.bumpPool();
    return view;
  }

  async timeOffs(expertId: string): Promise<TimeOffView[]> {
    if ((await this.deps.expertsRepository.findById(expertId)) === null) throw new NotFoundError('Expert');
    return this.deps.expertsRepository.timeOffs(expertId, new Date());
  }

  async addTimeOff(actor: Actor, expertId: string, input: TimeOffInput): Promise<TimeOffView> {
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    const issues: Issue[] = [];
    if (endAt <= startAt) issues.push({ path: 'endAt', message: 'endAt must be after startAt' });
    if (endAt <= new Date()) issues.push({ path: 'endAt', message: 'time-off must end in the future' });
    if (endAt.getTime() - startAt.getTime() > MAX_TIME_OFF_DAYS * 86_400_000)
      issues.push({ path: 'endAt', message: `time-off spans at most ${MAX_TIME_OFF_DAYS} days` });
    if (issues.length > 0) throw new ValidationError(issues);
    if (actor.userId === null) throw new Error('addTimeOff needs a user actor');
    const createdBy = actor.userId;
    const row = await this.deps.runInTransaction(async (tx) => {
      await this.mustLock(tx, expertId);
      const created = await this.deps.expertsRepository.createTimeOff(tx, expertId, {
        startAt,
        endAt,
        reason: input.reason ?? null,
        createdByUserId: createdBy,
      });
      await this.audit(tx, actor, 'expert.time_off.add', expertId, null, { ...created });
      return created;
    });
    await this.deps.gens.bumpPool();
    return row;
  }

  async removeTimeOff(actor: Actor, expertId: string, timeOffId: string): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      await this.mustLock(tx, expertId);
      const removed = await this.deps.expertsRepository.deleteTimeOff(tx, expertId, timeOffId);
      if (removed === null) throw new NotFoundError('Time-off');
      await this.audit(tx, actor, 'expert.time_off.remove', expertId, { ...removed }, null);
    });
    await this.deps.gens.bumpPool();
  }

  // ── holidays ──

  holidays(from: string, to: string): Promise<HolidayView[]> {
    return this.deps.expertsRepository.holidays(from, to);
  }

  async addHoliday(actor: Actor, input: HolidayInput): Promise<HolidayView> {
    const row = await this.deps.runInTransaction(async (tx) => {
      if (await this.deps.expertsRepository.holidayExists(tx, input.date, input.territoryCode ?? null))
        throw conflict('A holiday already exists for this date and territory', 'HOLIDAY_EXISTS');
      const created = await this.deps.expertsRepository.createHoliday(tx, input);
      await this.deps.auditService.record(tx, actor, {
        action: 'holiday.create',
        targetType: 'holiday',
        targetId: created.id,
        after: { ...created },
      });
      return created;
    });
    await this.deps.gens.bumpPool();
    return row;
  }

  async removeHoliday(actor: Actor, id: string): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      const removed = await this.deps.expertsRepository.deleteHoliday(tx, id);
      if (removed === null) throw new NotFoundError('Holiday');
      await this.deps.auditService.record(tx, actor, {
        action: 'holiday.delete',
        targetType: 'holiday',
        targetId: id,
        before: { ...removed },
      });
    });
    await this.deps.gens.bumpPool();
  }

  // ── self ──

  async me(expertId: string): Promise<ExpertView & AvailabilityView & { online: boolean }> {
    const [profile, online] = await Promise.all([this.get(expertId), this.onlineSet([expertId])]);
    return { ...profile, online: online.has(expertId) };
  }

  async updateMe(actor: Actor, expertId: string, input: UpdateMyProfileInput): Promise<ExpertView> {
    return this.update(actor, expertId, input);
  }

  /** Heartbeat: online for PRESENCE_TTL_SEC. */
  async heartbeat(expertId: string): Promise<{ online: true; expiresInSeconds: number }> {
    await this.deps.redis.set(callKeys.presence(expertId), '1', 'EX', PRESENCE_TTL_SEC);
    return { online: true, expiresInSeconds: PRESENCE_TTL_SEC };
  }

  async goOffline(expertId: string): Promise<void> {
    await this.deps.redis.del(callKeys.presence(expertId));
  }

  // ── recommendation (customer) ──

  /**
   * The expert card above Continue: best product match, online first. Advice only — it never
   * decides who takes the call (`assignment: RECOMMENDATION_ONLY`).
   * Candidates are cached 30 s per (poolGen, brand, category path, production types); presence
   * is read fresh on every call.
   */
  async recommended(userId: string, query: RecommendQuery): Promise<RecommendedView> {
    const [product, farm] = await Promise.all([
      this.deps.productClient.card(query.productId),
      query.farmId === undefined ? Promise.resolve(null) : this.deps.farmClient.ownedActive(query.farmId, userId),
    ]);
    const categoryPath = await this.deps.catalogClient.pathIds(product.categoryId);
    const productionTypes = farm?.productionTypes ?? [];
    const poolGen = await this.deps.gens.poolGen();
    const hash = createHash('sha256')
      .update(JSON.stringify([product.brand.id, categoryPath, [...productionTypes].sort()]))
      .digest('base64url')
      .slice(0, 22);
    const candidates = await this.deps.cache.getOrSet(callKeys.recommended(poolGen, hash), RECOMMEND_TTL_SEC, () =>
      this.deps.expertsRepository.recommendCandidates({
        brandId: product.brand.id,
        categoryPath,
        productionTypes,
      }),
    );
    const online = await this.onlineSet(candidates.map((c) => c.id));
    const ranked = rankCandidates(
      candidates,
      { brandId: product.brand.id, categoryPath, productionTypes, language: query.language },
      online,
      query.limit,
    );
    const byId = new Map(candidates.map((c) => [c.id, c]));
    return {
      assignment: 'RECOMMENDATION_ONLY',
      experts: ranked.flatMap((s) => {
        const e = byId.get(s.id);
        return e === undefined
          ? []
          : [{ ...toCard(e), online: online.has(e.id), isBookable: e.isBookable, matchedOn: s.matchedOn }];
      }),
    };
  }

  // ── internals ──

  /** Ids with a live presence key (Redis down → nobody online). */
  async onlineSet(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    try {
      const values = await this.deps.redis.mget(...ids.map((id) => callKeys.presence(id)));
      return new Set(ids.filter((_, i) => values[i] !== null));
    } catch (err) {
      this.deps.logger.warn({ err }, 'presence read failed; showing everyone offline');
      return new Set();
    }
  }

  private async mustLock(tx: Tx, id: string, ifMatch?: number): Promise<ExpertView> {
    const expert = await this.deps.expertsRepository.lock(tx, id);
    if (expert === null) throw new NotFoundError('Expert');
    if (ifMatch !== undefined && ifMatch !== expert.version)
      throw conflict('The expert was changed by someone else; reload and retry', 'VERSION_MISMATCH');
    return expert;
  }

  /** Languages must be LANGUAGE option codes (read BEFORE any transaction). */
  private async checkLanguages(languages: readonly string[]): Promise<void> {
    const known = await this.deps.optionsService.activeCodes('LANGUAGE');
    const unknown = languages.filter((code) => !known.has(code));
    if (unknown.length > 0)
      throw new ValidationError(
        unknown.map((code) => ({ path: 'languages', message: `unknown language "${code}"` })),
      );
  }

  private audit(
    tx: Tx,
    actor: Actor,
    action: string,
    id: string,
    before: object | null,
    after: object | null,
    reason?: string,
  ): Promise<void> {
    return this.deps.auditService.record(tx, actor, {
      action,
      targetType: 'expert',
      targetId: id,
      before,
      after,
      reason: reason ?? null,
    });
  }
}
