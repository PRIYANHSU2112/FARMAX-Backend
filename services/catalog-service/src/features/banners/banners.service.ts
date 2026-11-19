import { createHash } from 'node:crypto';

import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { type Tx, isUniqueViolation, mapPrismaError } from '@farmx/database';
import { catalogKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { LocalCache } from '../../adapters/local-cache.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { Actor, AuditRecord } from '../audit/index.js';
import type {
  AdminBannerListQuery,
  AdminPlacementListQuery,
  BannerRecord,
  BannerSnapshot,
  BannerUpdateData,
  CreateBannerInput,
  CreatePlacementInput,
  PlacementRecord,
  PlacementUpdateData,
  PublicBannerQuery,
  PublicPlacement,
  ReorderBannersInput,
  SnapshotBanner,
  SnapshotPlacement,
  StatusInput,
  UpdateBannerInput,
  UpdatePlacementInput,
} from './banners.types.js';

type Deps = Pick<Cradle, 'bannersRepository' | 'cache' | 'runInTransaction' | 'auditService'>;

export interface Tagged<T> {
  etag: string;
  data: T;
}

/** Redis TTL is short so schedules converge even if nobody writes. */
const SNAPSHOT_TTL_SECONDS = 300;
const LOCAL_TTL_MS = 30_000;
const SNAPSHOT = 'banners';

/** Snapshot + in-process indexes (built once per load, O(1) lookups per request). */
export interface CompiledSnapshot extends BannerSnapshot {
  byCode: Map<string, SnapshotPlacement>;
  byApp: Map<string, SnapshotPlacement[]>;
}

// ── Pure helpers (exported for unit tests) ──

export const etagOf = (placements: readonly SnapshotPlacement[]): string => {
  const hash = createHash('sha1');
  for (const p of placements) {
    hash.update(`${p.id}:${String(p.version)};`);
    for (const b of p.banners) hash.update(`${b.id}:${String(b.version)},`);
  }
  return `W/"${hash.digest('base64url').slice(0, 22)}"`;
};

export const compile = (snap: BannerSnapshot): CompiledSnapshot => {
  const byCode = new Map<string, SnapshotPlacement>();
  const byApp = new Map<string, SnapshotPlacement[]>();
  for (const p of snap.placements) {
    byCode.set(p.code, p);
    const list = byApp.get(p.app);
    if (list === undefined) byApp.set(p.app, [p]);
    else list.push(p);
  }
  return { ...snap, byCode, byApp };
};

/** start ≤ now < end (null = open). */
export const isLive = (b: Pick<SnapshotBanner, 'startsAt' | 'endsAt'>, now: number): boolean =>
  (b.startsAt === null || b.startsAt <= now) && (b.endsAt === null || b.endsAt > now);

export const toPublic = (p: SnapshotPlacement, now: number): PublicPlacement => {
  const banners = [];
  for (const b of p.banners) {
    if (banners.length >= p.maxItems) break;
    if (!isLive(b, now)) continue;
    banners.push({
      id: b.id,
      title: b.title,
      subtitle: b.subtitle,
      imageUrl: b.imageUrl,
      mobileImageUrl: b.mobileImageUrl,
      actionType: b.actionType,
      actionTarget: b.actionTarget,
      sortOrder: b.sortOrder,
    });
  }
  return {
    code: p.code,
    app: p.app,
    page: p.page,
    position: p.position,
    aspectRatio: p.aspectRatio,
    maxItems: p.maxItems,
    banners,
  };
};

export const selectPlacements = (
  snap: CompiledSnapshot,
  query: PublicBannerQuery,
  now: number,
): PublicPlacement[] =>
  (snap.byApp.get(query.app) ?? [])
    .filter(
      (p) =>
        (query.page === undefined || p.page === query.page) &&
        (query.position === undefined || p.position === query.position),
    )
    .map((p) => toPublic(p, now));

/**
 * Per-response ETag: snapshot ETag + the visible banner ids, so a banner going live / expiring
 * (no write, no version change) still changes the ETag.
 */
export const responseEtag = (snapEtag: string, placements: readonly PublicPlacement[]): string => {
  const hash = createHash('sha1').update(snapEtag);
  for (const p of placements) {
    hash.update(p.code);
    for (const b of p.banners) hash.update(b.id);
  }
  return `W/"${hash.digest('base64url').slice(0, 22)}"`;
};

const versionConflict = (what: string, current: number) =>
  new ConflictError(`The ${what} was changed by someone else; reload and retry`, {
    details: { reason: 'BANNER_VERSION_CONFLICT', currentVersion: current },
  });

const codeTaken = () =>
  new ConflictError('A placement with this code already exists', {
    details: { reason: 'PLACEMENT_DUPLICATE', fields: ['code'] },
  });

/** Partial-update diff: only fields that actually change (dates compared by value). */
const diff = <T extends object>(changes: Partial<T>, current: T): Partial<T> => {
  const data: Partial<T> = {};
  for (const [key, raw] of Object.entries(changes)) {
    const value = raw === '' ? null : raw;
    const now = current[key as keyof T] as unknown;
    const same =
      value instanceof Date && now instanceof Date
        ? value.getTime() === now.getTime()
        : value === now;
    if (value !== undefined && !same) Object.assign(data, { [key]: value });
  }
  return data;
};

/**
 * Banners + placements. Public reads: one snapshot of every active placement with its banners
 * (in-process 30 s → Redis 5 min single-flight → one query), filtered per request in memory
 * (schedule window, maxItems). Writes: one transaction under a lock, audited, caches dropped.
 */
export class BannersService {
  private readonly local = new LocalCache<CompiledSnapshot>(1, LOCAL_TTL_MS);

  constructor(private readonly deps: Deps) {}

  private async snapshot(): Promise<CompiledSnapshot> {
    let snap = this.local.get(SNAPSHOT);
    if (snap === undefined) {
      const raw = await this.deps.cache.getOrSet<BannerSnapshot>(
        catalogKeys.banners(),
        SNAPSHOT_TTL_SECONDS,
        async () => {
          const placements = await this.deps.bannersRepository.loadSnapshot(new Date());
          return { placements, etag: etagOf(placements) };
        },
      );
      snap = compile(raw);
      this.local.set(SNAPSHOT, snap);
    }
    return snap;
  }

  private async invalidate(): Promise<void> {
    this.local.delete(SNAPSHOT);
    await this.deps.cache.invalidate(catalogKeys.banners()).catch(() => undefined);
  }

  // ── Storefront ──

  async publicList(query: PublicBannerQuery): Promise<Tagged<PublicPlacement[]>> {
    const snap = await this.snapshot();
    const data = selectPlacements(snap, query, Date.now());
    return { etag: responseEtag(snap.etag, data), data };
  }

  async publicByCode(code: string): Promise<Tagged<PublicPlacement>> {
    const snap = await this.snapshot();
    const placement = snap.byCode.get(code);
    if (placement === undefined) throw new NotFoundError('Banner placement');
    const data = toPublic(placement, Date.now());
    return { etag: responseEtag(snap.etag, [data]), data };
  }

  // ── Admin: placements ──

  listPlacements(query: AdminPlacementListQuery): Promise<Paginated<PlacementRecord>> {
    return this.deps.bannersRepository.listPlacements(query);
  }

  async placement(id: string): Promise<PlacementRecord> {
    const row = await this.deps.bannersRepository.findPlacement(id);
    if (row === null) throw new NotFoundError('Banner placement');
    return row;
  }

  async createPlacement(input: CreatePlacementInput, actor: Actor): Promise<PlacementRecord> {
    const { reason, ...fields } = input;
    return this.write(async (tx) => {
      if (await this.deps.bannersRepository.codeTaken(tx, fields.code)) throw codeTaken();
      const id = uuidv7();
      const created = await this.deps.bannersRepository.createPlacement(tx, {
        id,
        code: fields.code,
        name: fields.name,
        app: fields.app,
        page: fields.page,
        position: fields.position,
        aspectRatio: fields.aspectRatio,
        maxItems: fields.maxItems ?? 5,
        isActive: fields.isActive ?? true,
        actorUserId: actor.userId,
      });
      await this.audit(tx, actor, 'banner_placement.create', id, null, created, reason);
      return created;
    });
  }

  updatePlacement(
    id: string,
    input: UpdatePlacementInput | StatusInput,
    ifMatch: number | undefined,
    actor: Actor,
    action: 'banner_placement.update' | 'banner_placement.status',
  ): Promise<PlacementRecord> {
    const { reason, ...changes } = input;
    return this.write(async (tx) => {
      const current = await this.livePlacement(tx, id, ifMatch);
      const data = diff<PlacementUpdateData>(changes, current);
      if (Object.keys(data).length === 0) return current;
      const updated = await this.deps.bannersRepository.updatePlacement(tx, id, data, actor.userId);
      await this.audit(tx, actor, action, id, pick(current, data), data, reason);
      return updated;
    });
  }

  /** Blocked while the placement still has banners (move or delete them first). */
  async removePlacement(
    id: string,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<void> {
    await this.write(async (tx) => {
      const current = await this.livePlacement(tx, id, ifMatch);
      const count = await this.deps.bannersRepository.liveBannerCount(tx, id);
      if (count > 0)
        throw new ConflictError('The placement still has banners; move or delete them first', {
          details: { reason: 'PLACEMENT_IN_USE', bannerCount: count },
        });
      await this.deps.bannersRepository.softDeletePlacement(tx, id, actor.userId);
      await this.audit(tx, actor, 'banner_placement.delete', id, current, null, reason);
    });
  }

  // ── Admin: banners ──

  listBanners(query: AdminBannerListQuery): Promise<Paginated<BannerRecord>> {
    return this.deps.bannersRepository.listBanners(query, new Date());
  }

  async banner(id: string): Promise<BannerRecord> {
    const row = await this.deps.bannersRepository.findBanner(id);
    if (row === null) throw new NotFoundError('Banner');
    return row;
  }

  history(
    targetType: 'banner' | 'banner_placement',
    id: string,
    query: { cursor?: string; limit: number },
  ): Promise<Paginated<AuditRecord>> {
    return this.deps.auditService.history(targetType, id, query);
  }

  async createBanner(input: CreateBannerInput, actor: Actor): Promise<BannerRecord> {
    const { reason, ...fields } = input;
    return this.write(async (tx) => {
      await this.livePlacement(tx, fields.placementId, undefined);
      const id = uuidv7();
      const created = await this.deps.bannersRepository.createBanner(tx, {
        id,
        placementId: fields.placementId,
        title: fields.title,
        subtitle: fields.subtitle === '' ? null : (fields.subtitle ?? null),
        imageUrl: fields.imageUrl,
        mobileImageUrl: fields.mobileImageUrl ?? null,
        actionType: fields.actionType ?? 'NONE',
        actionTarget: fields.actionTarget ?? null,
        sortOrder: fields.sortOrder ?? 0,
        isActive: fields.isActive ?? true,
        startDate: fields.startDate ?? null,
        endDate: fields.endDate ?? null,
        actorUserId: actor.userId,
      });
      await this.audit(tx, actor, 'banner.create', id, null, created, reason);
      return created;
    });
  }

  updateBanner(
    id: string,
    input: UpdateBannerInput | StatusInput,
    ifMatch: number | undefined,
    actor: Actor,
    action: 'banner.update' | 'banner.status',
  ): Promise<BannerRecord> {
    const { reason, ...changes } = input;
    return this.write(async (tx) => {
      const current = await this.liveBanner(tx, id, ifMatch);
      const data = diff<BannerUpdateData>(changes, current);
      if (Object.keys(data).length === 0) return current;
      if (data.placementId !== undefined) await this.livePlacement(tx, data.placementId, undefined);
      const start = data.startDate === undefined ? current.startDate : data.startDate;
      const end = data.endDate === undefined ? current.endDate : data.endDate;
      if (start !== null && end !== null && end <= start)
        throw new ValidationError([{ path: 'body.endDate', message: 'must be after startDate' }]);
      const updated = await this.deps.bannersRepository.updateBanner(tx, id, data, actor.userId);
      await this.audit(tx, actor, action, id, pick(current, data), data, reason);
      return updated;
    });
  }

  async removeBanner(
    id: string,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<void> {
    await this.write(async (tx) => {
      const current = await this.liveBanner(tx, id, ifMatch);
      await this.deps.bannersRepository.softDeleteBanner(tx, id, actor.userId);
      await this.audit(tx, actor, 'banner.delete', id, current, null, reason);
    });
  }

  /** Every id must be a live banner of the placement; listed order → sortOrder 10, 20, 30 … */
  async reorder(input: ReorderBannersInput, actor: Actor): Promise<{ updated: number }> {
    const { placementId, ids, reason } = input;
    return this.write(async (tx) => {
      await this.livePlacement(tx, placementId, undefined);
      const found = await this.deps.bannersRepository.countInPlacement(tx, placementId, ids);
      if (found !== ids.length)
        throw new ValidationError([
          { path: 'body.ids', message: 'every id must be a live banner of this placement' },
        ]);
      const updated = await this.deps.bannersRepository.reorder(tx, ids, actor.userId);
      await this.audit(
        tx,
        actor,
        'banner.reorder',
        placementId,
        null,
        { ids },
        reason,
        'banner_placement',
      );
      return { updated };
    });
  }

  // ── Helpers ──

  /** One transaction under the banners lock; caches dropped after commit. */
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await this.deps.runInTransaction(async (tx) => {
        await this.deps.bannersRepository.lock(tx);
        return work(tx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw codeTaken();
      const mapped = mapPrismaError(error);
      throw mapped instanceof Error ? mapped : error;
    }
    await this.invalidate();
    return result;
  }

  private audit(
    tx: Tx,
    actor: Actor,
    action: string,
    targetId: string,
    before: object | null,
    after: object | null,
    reason: string,
    targetType: 'banner' | 'banner_placement' = action.startsWith('banner_placement')
      ? 'banner_placement'
      : 'banner',
  ): Promise<void> {
    return this.deps.auditService.record(tx, actor, {
      action,
      targetType,
      targetId,
      before,
      after,
      reason,
    });
  }

  private async livePlacement(
    tx: Tx,
    id: string,
    ifMatch: number | undefined,
  ): Promise<PlacementRecord> {
    const row = await this.deps.bannersRepository.findPlacement(id, tx);
    if (row === null) throw new NotFoundError('Banner placement');
    if (ifMatch !== undefined && ifMatch !== row.version)
      throw versionConflict('placement', row.version);
    return row;
  }

  private async liveBanner(tx: Tx, id: string, ifMatch: number | undefined): Promise<BannerRecord> {
    const row = await this.deps.bannersRepository.findBanner(id, tx);
    if (row === null) throw new NotFoundError('Banner');
    if (ifMatch !== undefined && ifMatch !== row.version)
      throw versionConflict('banner', row.version);
    return row;
  }
}

const pick = <T extends object>(current: T, data: Partial<T>): object =>
  Object.fromEntries(Object.keys(data).map((key) => [key, current[key as keyof T]]));
