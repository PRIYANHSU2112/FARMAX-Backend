import type { Paginated } from '@farmx/common/types';
import { type Tx, advisoryXactLock, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  AdminBannerListQuery,
  AdminPlacementListQuery,
  BannerRecord,
  BannerUpdateData,
  PlacementRecord,
  PlacementUpdateData,
  SnapshotPlacement,
} from './banners.types.js';

const PLACEMENT_SELECT = {
  id: true,
  code: true,
  name: true,
  app: true,
  page: true,
  position: true,
  aspectRatio: true,
  maxItems: true,
  isActive: true,
  version: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BannerPlacementSelect;

const BANNER_SELECT = {
  id: true,
  placementId: true,
  title: true,
  subtitle: true,
  imageUrl: true,
  mobileImageUrl: true,
  actionType: true,
  actionTarget: true,
  sortOrder: true,
  isActive: true,
  startDate: true,
  endDate: true,
  version: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BannerSelect;

const PLACEMENT_ORDER: Prisma.BannerPlacementOrderByWithRelationInput[] = [
  { app: 'asc' },
  { page: 'asc' },
  { position: 'asc' },
  { id: 'asc' },
];
const BANNER_ORDER: Prisma.BannerOrderByWithRelationInput[] = [
  { placementId: 'asc' },
  { sortOrder: 'asc' },
  { id: 'asc' },
];

const BANNERS_LOCK = 'catalog:banners';
const ms = (d: Date | null) => (d === null ? null : d.getTime());

export type PlacementCreateData = Omit<
  PlacementRecord,
  'version' | 'createdByUserId' | 'updatedByUserId' | 'createdAt' | 'updatedAt'
> & { actorUserId: string };

export type BannerCreateData = Omit<
  BannerRecord,
  'version' | 'createdByUserId' | 'updatedByUserId' | 'createdAt' | 'updatedAt'
> & { actorUserId: string };

type Client = Cradle['db'] | Tx;

/** Only place that queries `banner_placements` / `banners`. Write-path reads take `tx`. */
export class BannersRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Serialises banner/placement writes (rare, admin-only). */
  lock(tx: Tx): Promise<void> {
    return advisoryXactLock(tx, BANNERS_LOCK);
  }

  /**
   * Public snapshot in ONE query: live active placements with their live, active, not-yet-expired
   * banners. Dates become epoch ms (JSON-safe for Redis).
   */
  async loadSnapshot(now: Date): Promise<SnapshotPlacement[]> {
    const rows = await withPrismaErrors(() =>
      this.db.bannerPlacement.findMany({
        where: { deletedAt: null, isActive: true },
        orderBy: PLACEMENT_ORDER,
        select: {
          id: true,
          code: true,
          app: true,
          page: true,
          position: true,
          aspectRatio: true,
          maxItems: true,
          version: true,
          banners: {
            where: {
              deletedAt: null,
              isActive: true,
              OR: [{ endDate: null }, { endDate: { gt: now } }],
            },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              title: true,
              subtitle: true,
              imageUrl: true,
              mobileImageUrl: true,
              actionType: true,
              actionTarget: true,
              sortOrder: true,
              startDate: true,
              endDate: true,
              version: true,
            },
          },
        },
      }),
    );
    return rows.map(({ banners, ...p }) => ({
      ...p,
      banners: banners.map(({ startDate, endDate, ...b }) => ({
        ...b,
        startsAt: ms(startDate),
        endsAt: ms(endDate),
      })),
    }));
  }

  // ── Placements ──

  findPlacement(id: string, client: Client = this.db): Promise<PlacementRecord | null> {
    return withPrismaErrors(() =>
      client.bannerPlacement.findFirst({
        where: { id, deletedAt: null },
        select: PLACEMENT_SELECT,
      }),
    );
  }

  async listPlacements(query: AdminPlacementListQuery): Promise<Paginated<PlacementRecord>> {
    const q = query.q?.trim();
    const where: Prisma.BannerPlacementWhereInput = {
      deletedAt: null,
      ...(query.app === undefined ? {} : { app: query.app }),
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.position === undefined ? {} : { position: query.position }),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(q === undefined || q === ''
        ? {}
        : {
            OR: [
              { code: { contains: q.toUpperCase() } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          }),
    };
    const rows = await withPrismaErrors(() =>
      this.db.bannerPlacement.findMany({
        where,
        select: PLACEMENT_SELECT,
        orderBy: PLACEMENT_ORDER,
        ...cursorArgs(query),
      }),
    );
    return toPage(rows, query.limit);
  }

  async codeTaken(tx: Tx, code: string): Promise<boolean> {
    const row = await tx.bannerPlacement.findFirst({
      where: { code, deletedAt: null },
      select: { id: true },
    });
    return row !== null;
  }

  createPlacement(tx: Tx, { actorUserId, ...data }: PlacementCreateData): Promise<PlacementRecord> {
    return tx.bannerPlacement.create({
      data: { ...data, createdByUserId: actorUserId, updatedByUserId: actorUserId },
      select: PLACEMENT_SELECT,
    });
  }

  updatePlacement(
    tx: Tx,
    id: string,
    data: PlacementUpdateData,
    actorUserId: string,
  ): Promise<PlacementRecord> {
    return tx.bannerPlacement.update({
      where: { id },
      data: { ...data, updatedByUserId: actorUserId, version: { increment: 1 } },
      select: PLACEMENT_SELECT,
    });
  }

  async softDeletePlacement(tx: Tx, id: string, actorUserId: string): Promise<void> {
    await tx.bannerPlacement.update({
      where: { id },
      data: { deletedAt: new Date(), updatedByUserId: actorUserId, version: { increment: 1 } },
    });
  }

  liveBannerCount(tx: Tx, placementId: string): Promise<number> {
    return tx.banner.count({ where: { placementId, deletedAt: null } });
  }

  // ── Banners ──

  findBanner(id: string, client: Client = this.db): Promise<BannerRecord | null> {
    return withPrismaErrors(() =>
      client.banner.findFirst({ where: { id, deletedAt: null }, select: BANNER_SELECT }),
    );
  }

  async listBanners(query: AdminBannerListQuery, now: Date): Promise<Paginated<BannerRecord>> {
    const q = query.q?.trim();
    const and: Prisma.BannerWhereInput[] = [];
    switch (query.state) {
      case 'LIVE':
        and.push(
          { isActive: true },
          { OR: [{ startDate: null }, { startDate: { lte: now } }] },
          { OR: [{ endDate: null }, { endDate: { gt: now } }] },
        );
        break;
      case 'SCHEDULED':
        and.push({ isActive: true }, { startDate: { gt: now } });
        break;
      case 'EXPIRED':
        and.push({ endDate: { lte: now } });
        break;
      case 'INACTIVE':
        and.push({ isActive: false });
        break;
      default:
        break;
    }
    const where: Prisma.BannerWhereInput = {
      deletedAt: null,
      ...(query.placementId === undefined ? {} : { placementId: query.placementId }),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(q === undefined || q === '' ? {} : { title: { contains: q, mode: 'insensitive' } }),
      ...(and.length === 0 ? {} : { AND: and }),
    };
    const rows = await withPrismaErrors(() =>
      this.db.banner.findMany({
        where,
        select: BANNER_SELECT,
        orderBy: BANNER_ORDER,
        ...cursorArgs(query),
      }),
    );
    return toPage(rows, query.limit);
  }

  createBanner(tx: Tx, { actorUserId, ...data }: BannerCreateData): Promise<BannerRecord> {
    return tx.banner.create({
      data: { ...data, createdByUserId: actorUserId, updatedByUserId: actorUserId },
      select: BANNER_SELECT,
    });
  }

  updateBanner(
    tx: Tx,
    id: string,
    data: BannerUpdateData,
    actorUserId: string,
  ): Promise<BannerRecord> {
    return tx.banner.update({
      where: { id },
      data: { ...data, updatedByUserId: actorUserId, version: { increment: 1 } },
      select: BANNER_SELECT,
    });
  }

  async softDeleteBanner(tx: Tx, id: string, actorUserId: string): Promise<void> {
    await tx.banner.update({
      where: { id },
      data: { deletedAt: new Date(), updatedByUserId: actorUserId, version: { increment: 1 } },
    });
  }

  /** How many of `ids` are live banners of `placementId`. */
  countInPlacement(tx: Tx, placementId: string, ids: readonly string[]): Promise<number> {
    return tx.banner.count({ where: { id: { in: [...ids] }, placementId, deletedAt: null } });
  }

  /** Sets sortOrder = 10, 20, 30 … in the given order (one statement). */
  reorder(tx: Tx, ids: readonly string[], actorUserId: string): Promise<number> {
    const orders = ids.map((_, i) => (i + 1) * 10);
    return tx.$executeRaw`
      UPDATE "banners" AS b SET
        "sortOrder" = v.ord,
        "version" = b."version" + 1,
        "updatedByUserId" = ${actorUserId}::uuid,
        "updatedAt" = now()
      FROM unnest(${[...ids]}::uuid[], ${orders}::int[]) AS v(id, ord)
      WHERE b."id" = v.id AND b."deletedAt" IS NULL`;
  }
}
