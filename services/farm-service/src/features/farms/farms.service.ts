import { randomUUID } from 'node:crypto';

import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { FARM_EVENTS, type FarmFactsV1 } from '@farmx/infra/events';
import { farmKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import { scoreCandidates } from './farm.dedupe.js';
import {
  CATEGORY_RULES,
  TYPE_CODES,
  assertEditable,
  assertTransition,
  buildFarmCode,
  normalizeName,
  validateDetails,
} from './farm.rules.js';
import type { FarmPatch, OwnerPatch } from './farms.repository.js';
import type {
  ActorType,
  AdminAction,
  AdminFarmListItem,
  AdminFarmListQuery,
  AdminUpdateInput,
  DetailsInput,
  FarmCategory,
  FarmContext,
  FarmListQuery,
  FarmPassView,
  FarmStatus,
  FarmSummary,
  FarmView,
  LocationInput,
  OwnerPrefsInput,
  OwnerSegment,
  QuickSignupInput,
  ReaderContext,
  UpdateActiveFarmInput,
} from './farms.types.js';

const FARM_TTL = 300;
const LIST_TTL = 300;
const STATS_TTL = 60;
const CODE_TTL = 7 * 86_400;

/** Statuses where the owner can still use KYC / billing endpoints. */
const KYC_OPEN: readonly FarmStatus[] = ['DRAFT', 'NEEDS_ATTENTION', 'UNDER_REVIEW', 'ACTIVE'];

const ADMIN_TARGET: Readonly<Record<AdminAction, FarmStatus>> = {
  suspend: 'SUSPENDED',
  reactivate: 'ACTIVE',
  close: 'CLOSED',
  reject: 'REJECTED',
  'request-changes': 'NEEDS_ATTENTION',
};

/**
 * Where each admin action may start. Narrower than the state machine on purpose: e.g.
 * `reactivate` must never turn an UNDER_REVIEW farm ACTIVE (that would skip the duplicate review).
 */
const ADMIN_FROM: Readonly<Record<AdminAction, readonly FarmStatus[]>> = {
  suspend: ['ACTIVE'],
  reactivate: ['SUSPENDED'],
  close: ['ACTIVE', 'SUSPENDED', 'NEEDS_ATTENTION'],
  reject: ['UNDER_REVIEW', 'NEEDS_ATTENTION'],
  'request-changes': ['UNDER_REVIEW'],
};

type Deps = Pick<
  Cradle,
  | 'farmsRepository'
  | 'geoService'
  | 'auditService'
  | 'outbox'
  | 'cache'
  | 'runInTransaction'
  | 'config'
  | 'pii'
  | 'logger'
> & { reviewService: Cradle['reviewService'] };

const totalBirds = (caps: readonly { metric: string; value: number }[]): number | null => {
  const birds = caps.filter((c) => c.metric === 'BIRDS');
  return birds.length === 0 ? null : Math.round(birds.reduce((s, c) => s + c.value, 0));
};

const titleCase = (s: string): string =>
  s.charAt(0) + s.slice(1).toLowerCase().replaceAll('_', ' ');

/**
 * Public API of the farms feature: registration journey, Farm ID issuance, admin management and
 * internal reads. Deps are read lazily (`this.deps.x`) because farms ↔ review call each other.
 */
export class FarmsService {
  constructor(private readonly deps: Deps) {}

  // ── Reads (cache-first, ownership-checked) ──

  /** Cached full view (Redis, single-flight). `null` results are cached too (no DB hammering). */
  private cachedView(id: string): Promise<FarmView | null> {
    return this.deps.cache.getOrSet(farmKeys.farm(id), FARM_TTL, () =>
      this.deps.farmsRepository.findView(id),
    );
  }

  /** 404 (never 403) for farms the caller does not own: no id enumeration. */
  async getOwned(userId: string, id: string): Promise<FarmView> {
    const view = await this.cachedView(id);
    if (view?.owner.userId !== userId) throw new NotFoundError('Farm');
    return view;
  }

  async listOwned(userId: string, query: FarmListQuery): Promise<Paginated<FarmSummary>> {
    const firstPage = query.cursor === undefined && query.status === undefined;
    if (!firstPage) return this.deps.farmsRepository.listForUser(userId, query);
    const cached = await this.deps.cache.getOrSet(farmKeys.userFarms(userId), LIST_TTL, () =>
      this.deps.farmsRepository.listForUser(userId, { limit: 50 }),
    );
    // One cached 50-row page serves any first-page limit ≤ 50.
    if (query.limit >= cached.items.length) return { ...cached, limit: query.limit };
    const items = cached.items.slice(0, query.limit);
    return { items, nextCursor: items.at(-1)?.id ?? null, limit: query.limit };
  }

  categories() {
    return Object.entries(CATEGORY_RULES).map(([category, rule]) => ({
      category,
      title: rule.title,
      subtitle: rule.subtitle,
      productionTypes: rule.productionTypes.map((type) => ({ type, typeCode: TYPE_CODES[type] })),
      capacityFields: rule.capacity,
      requiredDocs: rule.requiredDocs,
      kycRequired: rule.kycRequired,
    }));
  }

  // ── Registration journey ──

  async createDraft(actor: Actor, category: FarmCategory, phone: string | null): Promise<FarmView> {
    if (category === 'BACKYARD') {
      throw new ValidationError([
        { path: 'category', message: 'use POST /farms/quick for backyard buyers' },
      ]);
    }
    const { farmsRepository, runInTransaction, config } = this.deps;
    const owner = await farmsRepository.findOwnerByUserId(actor.userId);
    if (
      owner !== null &&
      (await farmsRepository.countOpenDrafts(owner.id)) >= config.MAX_OPEN_DRAFTS
    ) {
      throw new ConflictError('Finish or discard an open registration first', {
        details: { reason: 'DRAFT_LIMIT_REACHED' },
      });
    }
    const types = CATEGORY_RULES[category].productionTypes;
    const view = await runInTransaction(async (tx) => {
      const { id: ownerId } = await farmsRepository.upsertOwner(tx, actor.userId, { phone });
      const farm = await farmsRepository.create(tx, {
        ownerId,
        category,
        productionTypes: types.length === 1 ? [...types] : [],
        name: '',
        channel: 'SELF',
        createdByUserId: actor.userId,
      });
      await farmsRepository.insertStatusEvent(tx, {
        farmId: farm.id,
        fromStatus: null,
        toStatus: 'DRAFT',
        actorType: 'OWNER',
        actorUserId: actor.userId,
        requestId: actor.requestId,
      });
      return this.mustFind(tx, farm.id);
    });
    await this.invalidate(view);
    return view;
  }

  /** Backyard quick sign-up: one call, active immediately (no KYC, no dedupe review). */
  async quickSignup(
    actor: Actor,
    input: QuickSignupInput,
    phone: string | null,
  ): Promise<FarmView> {
    const pin = await this.deps.geoService.resolveServiceablePin(input.pinCode);
    const { farmsRepository } = this.deps;
    const view = await this.deps.runInTransaction(async (tx) => {
      const { id: ownerId } = await farmsRepository.upsertOwner(tx, actor.userId, {
        fullName: input.ownerName,
        phone,
      });
      const farm = await farmsRepository.create(tx, {
        ownerId,
        category: 'BACKYARD',
        productionTypes: ['BACKYARD'],
        name: input.ownerName,
        channel: 'SELF',
        createdByUserId: actor.userId,
      });
      const capacities =
        input.birds === undefined
          ? []
          : [
              {
                productionType: 'BACKYARD' as const,
                metric: 'BIRDS' as const,
                value: input.birds,
                period: 'STANDING' as const,
              },
            ];
      await farmsRepository.replaceCapacities(tx, farm.id, ['BACKYARD'], capacities);
      await this.save(tx, farm.id, 0, {
        ...this.locationPatch(
          input.latitude === undefined || input.longitude === undefined ? null : input,
          pin,
        ),
        addressLine: input.addressLine,
        village: input.village,
        pinCode: input.pinCode,
        totalBirdCapacity: input.birds ?? null,
        registrationStep: 5,
      });
      if (input.personalizedOffers !== undefined) {
        await farmsRepository.updateOwner(tx, ownerId, {
          personalizedOffers: input.personalizedOffers,
        });
        await farmsRepository.insertConsent(
          tx,
          ownerId,
          'PERSONALIZED_OFFERS',
          input.personalizedOffers,
          actor.ip,
        );
      }
      const draft = await this.mustFind(tx, farm.id);
      await this.activate(tx, draft, 'OWNER', actor);
      return this.mustFind(tx, farm.id);
    });
    await this.invalidate(view);
    return view;
  }

  updateDetails(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
    input: DetailsInput,
  ): Promise<FarmView> {
    return this.mutateOwned(actor, id, ifMatch, async (tx, farm) => {
      assertEditable(farm.status);
      const types = validateDetails(farm.category, input.productionTypes, input.capacities);
      await this.deps.farmsRepository.replaceCapacities(tx, id, types, input.capacities);
      await this.deps.farmsRepository.updateOwner(tx, farm.owner.id, { fullName: input.ownerName });
      return {
        name: input.name,
        nameNormalized: normalizeName(input.name),
        productionTypes: types,
        totalBirdCapacity: totalBirds(input.capacities),
        registrationStep: Math.max(farm.registrationStep, 2),
      };
    });
  }

  async setLocation(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
    input: LocationInput,
  ): Promise<FarmView> {
    const pin = await this.deps.geoService.resolveServiceablePin(input.pinCode);
    return this.mutateOwned(actor, id, ifMatch, (_tx, farm) => {
      assertEditable(farm.status);
      return Promise.resolve({
        ...this.locationPatch(input, pin),
        addressLine: input.addressLine ?? null,
        village: input.village,
        pinCode: input.pinCode,
        locationCapturedAt: new Date(input.capturedAt),
        registrationStep: Math.max(farm.registrationStep, 3),
      });
    });
  }

  updateOwnerPrefs(actor: Actor, id: string, input: OwnerPrefsInput): Promise<FarmView> {
    return this.mutateOwned(actor, id, undefined, async (tx, farm) => {
      const patch: OwnerPatch = {};
      if (input.ageBand !== undefined) patch.ageBand = input.ageBand;
      if (input.personalizedOffers !== undefined) {
        patch.personalizedOffers = input.personalizedOffers;
        await this.deps.farmsRepository.insertConsent(
          tx,
          farm.owner.id,
          'PERSONALIZED_OFFERS',
          input.personalizedOffers,
          actor.ip,
        );
      }
      await this.deps.farmsRepository.updateOwner(tx, farm.owner.id, patch);
      return { registrationStep: Math.max(farm.registrationStep, 5) };
    });
  }

  deferKyc(actor: Actor, id: string): Promise<FarmView> {
    return this.mutateOwned(actor, id, undefined, (_tx, farm) => {
      assertEditable(farm.status);
      if (!CATEGORY_RULES[farm.category].kycRequired) return Promise.resolve({});
      return Promise.resolve({
        kycDeferredAt: new Date(),
        registrationStep: Math.max(farm.registrationStep, 4),
      });
    });
  }

  async discardDraft(actor: Actor, id: string): Promise<void> {
    const view = await this.deps.runInTransaction(async (tx) => {
      const farm = await this.findOwnedInTx(tx, actor.userId, id);
      if (farm.status !== 'DRAFT')
        throw new ConflictError('Only drafts can be discarded', {
          details: { reason: 'FARM_STATE_INVALID' },
        });
      await this.deps.farmsRepository.softDelete(tx, id);
      return farm;
    });
    await this.invalidate(view);
  }

  /**
   * Submit (or resubmit after changes): completeness check → dedupe (one indexed query) →
   * ACTIVE with a Farm ID, or UNDER_REVIEW with a duplicate case. One transaction.
   */
  async submit(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
  ): Promise<{ farm: FarmView; caseId: string | null }> {
    let caseId: string | null = null;
    const farm = await this.mutateOwned(actor, id, ifMatch, async (tx, current) => {
      assertEditable(current.status);
      this.assertComplete(current);
      const { farmsRepository, config, outbox } = this.deps;
      const pan = await farmsRepository.findOwnerPan(current.owner.id);
      const loc = current.location;
      const candidates = await farmsRepository.findDuplicateCandidates(tx, {
        farmId: id,
        ownerId: current.owner.id,
        panHash: pan?.panHash ?? null,
        gstin: current.billing.gstin,
        latitude: loc?.latitude ?? null,
        longitude: loc?.longitude ?? null,
        nameNormalized: normalizeName(current.name),
        radiusM: config.DEDUPE_RADIUS_M,
      });
      const match = scoreCandidates(candidates, config.DEDUPE_RADIUS_M);
      await outbox.add(
        tx,
        FARM_EVENTS.farmSubmitted,
        {
          farmId: id,
          ownerId: current.owner.id,
          category: current.category,
          channel: current.channel,
        },
        actor.requestId,
      );
      if (match === null) {
        await this.activate(tx, current, 'OWNER', actor);
        return null; // activate() already wrote the row
      }
      await this.recordTransition(
        tx,
        current,
        'UNDER_REVIEW',
        'OWNER',
        actor,
        `Possible duplicate: ${match.signals.join(', ')}`,
      );
      const opened = await this.deps.reviewService.openCase(tx, current, match, actor.requestId);
      caseId = opened.id;
      return {
        status: 'UNDER_REVIEW',
        statusReason: null,
        statusChangedAt: new Date(),
        submittedAt: new Date(),
      };
    });
    return { farm, caseId };
  }

  async pass(userId: string, id: string): Promise<FarmPassView> {
    const farm = await this.getOwned(userId, id);
    if (farm.farmCode === null || farm.activatedAt === null) {
      throw new ConflictError('The Farm ID is not issued yet', {
        details: { reason: 'FARM_STATE_INVALID' },
      });
    }
    const loc = farm.location;
    const types = farm.productionTypes.map(titleCase).join(', ');
    const birds =
      farm.totalBirdCapacity === null
        ? ''
        : ` · ${farm.totalBirdCapacity.toLocaleString('en-IN')} birds`;
    return {
      farmCode: farm.farmCode,
      name: farm.name,
      ownerName: farm.owner.fullName,
      locationLabel: [loc?.village, loc?.districtName, loc?.pinCode].filter(Boolean).join(', '),
      productionSummary: `${types}${birds}`,
      totalBirdCapacity: farm.totalBirdCapacity,
      memberSince: farm.activatedAt,
      qr: { payload: `FX1:${farm.farmCode}`, signature: this.deps.pii.hash('pass', farm.farmCode) },
      shareText: `My FarmX Farm ID is ${farm.farmCode} (${farm.name}).`,
    };
  }

  /** Public QR check (drivers, field staff): signature-gated, minimal fields. */
  async verifyPass(farmCode: string, signature: string) {
    if (!this.deps.pii.verify('pass', farmCode, signature)) throw new NotFoundError('Farm');
    const farm = await this.findByCode(farmCode);
    if (farm === null) throw new NotFoundError('Farm');
    return {
      farmCode,
      name: farm.name,
      status: farm.status,
      territoryCode: farm.location?.territoryCode ?? null,
    };
  }

  updateActive(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
    input: UpdateActiveFarmInput,
  ): Promise<FarmView> {
    return this.mutateOwned(actor, id, ifMatch, async (tx, farm) => {
      if (farm.status !== 'ACTIVE')
        throw new ConflictError('Only active farms can be edited here', {
          details: { reason: 'FARM_STATE_INVALID' },
        });
      const patch: FarmPatch = {};
      if (input.addressLine !== undefined) patch.addressLine = input.addressLine;
      if (input.capacities !== undefined) {
        const types = validateDetails(farm.category, farm.productionTypes, input.capacities);
        await this.deps.farmsRepository.replaceCapacities(tx, id, types, input.capacities);
        patch.totalBirdCapacity = totalBirds(input.capacities);
      }
      await this.deps.outbox.add(
        tx,
        FARM_EVENTS.farmUpdated,
        { farmId: id, changedFields: Object.keys(input) },
        actor.requestId,
      );
      return patch;
    });
  }

  // ── Used by the kyc and review features (same transaction) ──

  /** Owner + farm for KYC endpoints (404 if not owned; 409 if the farm is closed). */
  async ownedContext(userId: string, id: string): Promise<FarmContext> {
    const farm = await this.getOwned(userId, id);
    if (!KYC_OPEN.includes(farm.status))
      throw new ConflictError('This farm is closed', { details: { reason: 'FARM_STATE_INVALID' } });
    return { farm, ownerId: farm.owner.id, ownerUserId: farm.owner.userId };
  }

  updateOwnerInTx(tx: Tx, ownerId: string, patch: OwnerPatch): Promise<void> {
    return this.deps.farmsRepository.updateOwner(tx, ownerId, patch);
  }

  recordConsent(tx: Tx, ownerId: string, granted: boolean, ip: string): Promise<void> {
    return this.deps.farmsRepository.insertConsent(tx, ownerId, 'AADHAAR_EKYC', granted, ip);
  }

  findOwnerPan(ownerId: string) {
    return this.deps.farmsRepository.findOwnerPan(ownerId);
  }

  /** GST state code of a territory (null when the farm has no location yet or it is unknown). */
  async territoryStateCode(territoryCode: string | null): Promise<string | null> {
    if (territoryCode === null) return null;
    const territories = await this.deps.geoService.listTerritories();
    return territories.find((t) => t.code === territoryCode)?.stateCode ?? null;
  }

  /** Internal patch from another feature (version re-read in the tx, so a stale view is safe). */
  async patchInTx(tx: Tx, farm: Pick<FarmView, 'id'>, patch: FarmPatch): Promise<void> {
    const latest = await this.mustFind(tx, farm.id);
    await this.save(tx, farm.id, latest.version, patch);
  }

  findInTx(tx: Tx, id: string): Promise<FarmView> {
    return this.mustFind(tx, id);
  }

  // ── Used by the content feature ──

  /** Reader targeting facts (404 when `farmId` is not the reader's farm). */
  async readerContext(userId: string, farmId?: string): Promise<ReaderContext | null> {
    const ctx = await this.deps.farmsRepository.readerContext(userId, farmId);
    if (ctx === null && farmId !== undefined) throw new NotFoundError('Farm');
    return ctx;
  }

  /** One page (by user id) of owners with an ACTIVE farm in the segment. */
  segmentOwnerIds(segment: OwnerSegment, after: string | null, limit: number): Promise<string[]> {
    return this.deps.farmsRepository.segmentOwnerIds(segment, after, limit);
  }

  /** Review decisions and admin actions: validated transition + event + side effects. */
  async transitionInTx(
    tx: Tx,
    farmId: string,
    to: FarmStatus,
    actor: Actor,
    actorType: ActorType,
    reason: string,
    extra: { mergedIntoFarmId?: string; issues?: { docType: string; code: string }[] } = {},
  ): Promise<FarmView> {
    const farm = await this.mustFind(tx, farmId);
    if (to === 'ACTIVE' && farm.farmCode === null) {
      await this.activate(tx, farm, actorType, actor, reason);
    } else {
      await this.recordTransition(tx, farm, to, actorType, actor, reason);
      await this.save(tx, farmId, farm.version, {
        status: to,
        statusReason: reason,
        statusChangedAt: new Date(),
        ...(extra.mergedIntoFarmId === undefined
          ? {}
          : { mergedIntoFarmId: extra.mergedIntoFarmId }),
      });
      const { outbox } = this.deps;
      if (to === 'MERGED' && extra.mergedIntoFarmId !== undefined) {
        await outbox.add(
          tx,
          FARM_EVENTS.farmMerged,
          { farmId, intoFarmId: extra.mergedIntoFarmId },
          actor.requestId,
        );
      }
      if (to === 'NEEDS_ATTENTION') {
        await outbox.add(
          tx,
          FARM_EVENTS.farmNeedsAttention,
          { farmId, ownerUserId: farm.owner.userId, issues: extra.issues ?? [] },
          actor.requestId,
        );
      }
    }
    return this.mustFind(tx, farmId);
  }

  /** Post-commit cache invalidation (best effort; TTLs bound any staleness). */
  async invalidate(farm: Pick<FarmView, 'id' | 'owner'>): Promise<void> {
    await this.deps.cache
      .invalidate(farmKeys.farm(farm.id), farmKeys.userFarms(farm.owner.userId), farmKeys.stats())
      .catch((err: unknown) => {
        this.deps.logger.warn(
          { err, farmId: farm.id },
          'farm cache invalidation failed; TTL applies',
        );
      });
  }

  // ── Admin ──

  adminList(query: AdminFarmListQuery): Promise<Paginated<AdminFarmListItem>> {
    return this.deps.farmsRepository.adminList(query);
  }

  /** Fresh from the DB (admins must never act on a stale cache) + last 20 status events. */
  async adminGet(id: string) {
    const [farm, events] = await Promise.all([
      this.deps.farmsRepository.findView(id),
      this.deps.farmsRepository.listStatusEvents(id),
    ]);
    if (farm === null) throw new NotFoundError('Farm');
    return {
      ...farm,
      statusHistory: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    };
  }

  async adminHistory(id: string, query: { cursor?: string; limit: number }) {
    const page = await this.deps.auditService.history('farm', id, query);
    return {
      ...page,
      items: page.items.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    };
  }

  async adminUpdate(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
    input: AdminUpdateInput,
  ): Promise<FarmView> {
    const view = await this.deps.runInTransaction(async (tx) => {
      const farm = await this.mustFind(tx, id);
      this.checkVersion(farm, ifMatch);
      const patch: FarmPatch = {};
      if (input.name !== undefined)
        Object.assign(patch, { name: input.name, nameNormalized: normalizeName(input.name) });
      if (input.addressLine !== undefined) patch.addressLine = input.addressLine;
      if (input.capacities !== undefined) {
        const types = validateDetails(farm.category, farm.productionTypes, input.capacities);
        await this.deps.farmsRepository.replaceCapacities(tx, id, types, input.capacities);
        patch.totalBirdCapacity = totalBirds(input.capacities);
      }
      if (input.ownerName !== undefined)
        await this.deps.farmsRepository.updateOwner(tx, farm.owner.id, {
          fullName: input.ownerName,
        });
      await this.save(tx, id, farm.version, patch);
      const { reason, ...changes } = input;
      await this.deps.auditService.record(tx, actor, {
        action: 'farm.update',
        targetType: 'farm',
        targetId: id,
        before: {
          name: farm.name,
          ownerName: farm.owner.fullName,
          addressLine: farm.location?.addressLine ?? null,
          capacities: farm.capacities,
        },
        after: changes,
        reason,
      });
      await this.deps.outbox.add(
        tx,
        FARM_EVENTS.farmUpdated,
        { farmId: id, changedFields: Object.keys(changes) },
        actor.requestId,
      );
      return this.mustFind(tx, id);
    });
    await this.invalidate(view);
    return view;
  }

  async adminAction(
    actor: Actor,
    id: string,
    action: AdminAction,
    input: { reason: string; issues?: { docType: string; code: string; message: string }[] },
    ifMatch: number | undefined,
  ): Promise<FarmView> {
    const to = ADMIN_TARGET[action];
    const view = await this.deps.runInTransaction(async (tx) => {
      const farm = await this.mustFind(tx, id);
      this.checkVersion(farm, ifMatch);
      if (!ADMIN_FROM[action].includes(farm.status)) {
        throw new ConflictError(`Cannot ${action} a ${farm.status} farm`, {
          details: { reason: 'FARM_STATE_INVALID', from: farm.status, action },
        });
      }
      if (farm.status === 'UNDER_REVIEW' && (await this.deps.reviewService.hasOpenCase(id))) {
        throw new ConflictError(
          'This farm has an open duplicate case; decide it from the review queue',
          {
            details: { reason: 'OPEN_REVIEW_CASE' },
          },
        );
      }
      assertTransition(farm.status, to);
      const updated = await this.transitionInTx(tx, id, to, actor, 'ADMIN', input.reason, {
        issues: input.issues?.map(({ docType, code }) => ({ docType, code })),
      });
      await this.deps.auditService.record(tx, actor, {
        action: `farm.${action}`,
        targetType: 'farm',
        targetId: id,
        before: { status: farm.status },
        after: { status: to, issues: input.issues ?? null },
        reason: input.reason,
      });
      return updated;
    });
    await this.invalidate(view);
    return view;
  }

  stats() {
    return this.deps.cache.getOrSet(farmKeys.stats(), STATS_TTL, async () => {
      const rows = await this.deps.farmsRepository.stats();
      const byStatus: Record<string, number> = {};
      const byCategory: Record<string, number> = {};
      for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] ?? 0) + r.count;
        byCategory[r.category] = (byCategory[r.category] ?? 0) + r.count;
      }
      return {
        total: rows.reduce((s, r) => s + r.count, 0),
        byStatus,
        byCategory,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  // ── Internal (service-to-service) ──

  async internalGet(id: string): Promise<FarmView> {
    const farm = await this.cachedView(id);
    if (farm === null) throw new NotFoundError('Farm');
    return farm;
  }

  internalBatch(ids: readonly string[]): Promise<FarmView[]> {
    return this.deps.farmsRepository.findViews(ids);
  }

  /** Farm ID → farm (the mapping is immutable, so it is cached for a week). */
  async findByCode(farmCode: string): Promise<FarmView | null> {
    const id = await this.deps.cache.getOrSet(farmKeys.code(farmCode), CODE_TTL, () =>
      this.deps.farmsRepository.findIdByCode(farmCode),
    );
    return id === null ? null : this.cachedView(id);
  }

  // ── Internals ──

  private async mustFind(tx: Tx, id: string): Promise<FarmView> {
    const farm = await this.deps.farmsRepository.findView(id, tx);
    if (farm === null) throw new NotFoundError('Farm');
    return farm;
  }

  private async findOwnedInTx(tx: Tx, userId: string, id: string): Promise<FarmView> {
    const farm = await this.deps.farmsRepository.findView(id, tx);
    if (farm?.owner.userId !== userId) throw new NotFoundError('Farm');
    return farm;
  }

  private checkVersion(farm: FarmView, ifMatch: number | undefined): void {
    if (ifMatch !== undefined && ifMatch !== farm.version) {
      throw new ConflictError('The farm was changed by someone else; reload and retry', {
        details: { reason: 'FARM_VERSION_CONFLICT', currentVersion: farm.version },
      });
    }
  }

  /** Load fresh in the tx → ownership + version check → patch → reload → invalidate after commit. */
  private async mutateOwned(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
    /** Returns the patch to apply, or `null` when `change` already wrote the farm row itself. */
    change: (tx: Tx, farm: FarmView) => Promise<FarmPatch | null>,
  ): Promise<FarmView> {
    // Round trips matter (remote DB): read → change → one versioned UPDATE → read back.
    const view = await this.deps.runInTransaction(async (tx) => {
      const farm = await this.findOwnedInTx(tx, actor.userId, id);
      this.checkVersion(farm, ifMatch);
      const patch = await change(tx, farm);
      if (patch !== null && Object.keys(patch).length > 0) {
        await this.save(tx, id, farm.version, patch);
      }
      return this.mustFind(tx, id);
    });
    await this.invalidate(view);
    return view;
  }

  private locationPatch(
    loc: { latitude?: number; longitude?: number; accuracyM?: number } | null,
    pin: Awaited<ReturnType<Deps['geoService']['resolveServiceablePin']>>,
  ): FarmPatch {
    return {
      ...(loc?.latitude === undefined || loc.longitude === undefined
        ? {}
        : {
            latitude: loc.latitude,
            longitude: loc.longitude,
            ...(loc.accuracyM === undefined ? {} : { gpsAccuracyM: loc.accuracyM }),
          }),
      territoryId: pin.territory.id,
      territoryCode: pin.territory.code,
      districtName: pin.districtName,
      mandalName: pin.mandalName,
      primaryNodeId: pin.primaryNode?.id ?? null,
      backupNodeId: pin.backupNode?.id ?? null,
    };
  }

  private assertComplete(farm: FarmView): void {
    const missing: string[] = [];
    if (farm.name.trim() === '' || farm.owner.fullName.trim() === '') missing.push('details');
    if (
      farm.productionTypes.length === 0 ||
      (farm.capacities.length === 0 && farm.category !== 'BACKYARD')
    )
      missing.push('capacities');
    if (farm.location === null) missing.push('location');
    if (
      CATEGORY_RULES[farm.category].kycRequired &&
      farm.owner.kycStatus === 'NOT_STARTED' &&
      !farm.kycDeferred
    )
      missing.push('kyc');
    if (missing.length > 0) {
      throw new ValidationError(
        missing.map((step) => ({ path: step, message: `${step} step is incomplete` })),
        'Registration is incomplete',
      );
    }
  }

  private recordTransition(
    tx: Tx,
    farm: FarmView,
    to: FarmStatus,
    actorType: ActorType,
    actor: Actor,
    reason: string | null,
  ): Promise<void> {
    assertTransition(farm.status, to);
    return this.deps.farmsRepository
      .insertStatusEvent(tx, {
        farmId: farm.id,
        fromStatus: farm.status,
        toStatus: to,
        reason,
        actorType,
        actorUserId: actor.userId,
        requestId: actor.requestId,
      })
      .then(() =>
        this.deps.outbox.add(
          tx,
          FARM_EVENTS.farmStatusChanged,
          { farmId: farm.id, from: farm.status, to, actorType },
          actor.requestId,
        ),
      );
  }

  /**
   * Every write to the farm row goes through here: versioned UPDATE, then a full facts snapshot
   * (`farm.facts_changed.v1`) in the same transaction for read models (order-service).
   */
  private async save(tx: Tx, id: string, version: number, patch: FarmPatch): Promise<void> {
    await this.deps.farmsRepository.update(tx, id, version, patch);
    const farm = await this.mustFind(tx, id);
    await this.deps.outbox.add(
      tx,
      FARM_EVENTS.farmFactsChanged,
      await this.factsOf(farm),
      randomUUID(),
    );
  }

  private async factsOf(farm: FarmView): Promise<FarmFactsV1> {
    const gstin = farm.billing.gstin;
    const territoryCode = farm.location?.territoryCode ?? null;
    const stateCode =
      gstin === null ? await this.territoryStateCode(territoryCode) : gstin.slice(0, 2);
    return {
      farmId: farm.id,
      farmCode: farm.farmCode,
      ownerUserId: farm.owner.userId,
      name: farm.name,
      category: farm.category,
      productionTypes: farm.productionTypes,
      gstin,
      gstVerified: farm.billing.gstVerified,
      gstBusinessName: farm.billing.businessName,
      gstTradeName: farm.billing.tradeName,
      invoiceName: farm.billing.invoiceName,
      gstVerifiedAt: farm.billing.gstVerifiedAt,
      stateCode,
      territoryCode,
      pinCode: farm.location?.pinCode ?? null,
      status: farm.status,
      version: farm.version,
    };
  }

  /** Issues the permanent Farm ID (D-25): atomic per-territory/type serial, same transaction. */
  private async activate(
    tx: Tx,
    farm: FarmView,
    actorType: ActorType,
    actor: Actor,
    reason: string | null = null,
  ): Promise<void> {
    const territory = farm.location?.territoryCode;
    const primary = farm.productionTypes[0];
    if (territory === undefined || territory === null || primary === undefined) {
      throw new ConflictError(
        'Location and production type are required before a Farm ID is issued',
        { details: { reason: 'FARM_STATE_INVALID' } },
      );
    }
    await this.recordTransition(tx, farm, 'ACTIVE', actorType, actor, reason);
    const serial = await this.deps.farmsRepository.nextSerial(tx, territory, TYPE_CODES[primary]);
    const farmCode = buildFarmCode(territory, primary, serial);
    const now = new Date();
    // `farm` is always read in this transaction by the caller, so its version is current.
    await this.save(tx, farm.id, farm.version, {
      status: 'ACTIVE',
      statusReason: reason,
      statusChangedAt: now,
      farmCode,
      activatedAt: now,
      ...(farm.submittedAt === null ? { submittedAt: now } : {}),
    });
    await this.deps.outbox.add(
      tx,
      FARM_EVENTS.farmActivated,
      {
        farmId: farm.id,
        farmCode,
        ownerId: farm.owner.id,
        ownerUserId: farm.owner.userId,
        category: farm.category,
        productionTypes: farm.productionTypes,
        territoryCode: territory,
        pinCode: farm.location?.pinCode ?? '',
        totalBirdCapacity: farm.totalBirdCapacity,
      },
      actor.requestId,
    );
  }
}
