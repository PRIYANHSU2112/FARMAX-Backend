import type { Paginated } from '@farmx/common/types';
import { type Tx, advisoryXactLock, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  AdminBrandListQuery,
  BrandRecord,
  BrandRow,
  BrandUpdateData,
} from './brands.types.js';

const ROW_SELECT = {
  id: true,
  name: true,
  slug: true,
  code: true,
  description: true,
  logoUrl: true,
  bannerUrl: true,
  websiteUrl: true,
  countryOfOrigin: true,
  isFeatured: true,
  isActive: true,
  sortOrder: true,
  version: true,
} satisfies Prisma.BrandSelect;

const RECORD_SELECT = {
  ...ROW_SELECT,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BrandSelect;

const ORDER: Prisma.BrandOrderByWithRelationInput[] = [
  { sortOrder: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
];

const BRANDS_LOCK = 'catalog:brands';

export interface BrandCreateData extends Omit<BrandRow, 'version'> {
  actorUserId: string;
}

type Client = Cradle['db'] | Tx;

/** Only place that queries `brands`. Write-path reads take `tx` (brand lock held). */
export class BrandsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Serialises brand writes (rare) so the uniqueness pre-check is race free. */
  lock(tx: Tx): Promise<void> {
    return advisoryXactLock(tx, BRANDS_LOCK);
  }

  /** Every live, active brand in display order (feeds the public snapshot). */
  loadActive(): Promise<BrandRow[]> {
    return withPrismaErrors(() =>
      this.db.brand.findMany({
        where: { deletedAt: null, isActive: true },
        select: ROW_SELECT,
        orderBy: ORDER,
      }),
    );
  }

  findLive(id: string, client: Client = this.db): Promise<BrandRecord | null> {
    return withPrismaErrors(() =>
      client.brand.findFirst({ where: { id, deletedAt: null }, select: RECORD_SELECT }),
    );
  }

  async list(query: AdminBrandListQuery): Promise<Paginated<BrandRecord>> {
    const q = query.q?.trim();
    const where: Prisma.BrandWhereInput = {
      deletedAt: null,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.isFeatured === undefined ? {} : { isFeatured: query.isFeatured }),
      ...(q === undefined || q === ''
        ? {}
        : {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { code: { contains: q.toUpperCase() } },
              { slug: { contains: q.toLowerCase() } },
            ],
          }),
    };
    const rows = await withPrismaErrors(() =>
      this.db.brand.findMany({
        where,
        select: RECORD_SELECT,
        orderBy: ORDER,
        ...cursorArgs(query),
      }),
    );
    return toPage(rows, query.limit);
  }

  /** Which unique keys are already used by another live brand. */
  async conflicts(
    tx: Tx,
    check: { name?: string; slug?: string; code?: string; excludeId?: string },
  ): Promise<('name' | 'slug' | 'code')[]> {
    const or: Prisma.BrandWhereInput[] = [];
    if (check.name !== undefined) or.push({ name: { equals: check.name, mode: 'insensitive' } });
    if (check.slug !== undefined) or.push({ slug: check.slug });
    if (check.code !== undefined) or.push({ code: check.code });
    if (or.length === 0) return [];
    const rows = await tx.brand.findMany({
      where: {
        deletedAt: null,
        ...(check.excludeId === undefined ? {} : { id: { not: check.excludeId } }),
        OR: or,
      },
      select: { name: true, slug: true, code: true },
      take: 3,
    });
    const taken: ('name' | 'slug' | 'code')[] = [];
    if (
      check.name !== undefined &&
      rows.some((r) => r.name.toLowerCase() === check.name?.toLowerCase())
    )
      taken.push('name');
    if (check.slug !== undefined && rows.some((r) => r.slug === check.slug)) taken.push('slug');
    if (check.code !== undefined && rows.some((r) => r.code === check.code)) taken.push('code');
    return taken;
  }

  /** Live slugs equal to `base` or `base-N` (to pick a free generated slug). */
  async slugsStartingWith(tx: Tx, base: string): Promise<Set<string>> {
    const rows = await tx.brand.findMany({
      where: { deletedAt: null, slug: { startsWith: base } },
      select: { slug: true },
    });
    return new Set(rows.map((r) => r.slug));
  }

  create(tx: Tx, { actorUserId, ...data }: BrandCreateData): Promise<BrandRecord> {
    return tx.brand.create({
      data: { ...data, createdByUserId: actorUserId, updatedByUserId: actorUserId },
      select: RECORD_SELECT,
    });
  }

  update(tx: Tx, id: string, data: BrandUpdateData, actorUserId: string): Promise<BrandRecord> {
    return tx.brand.update({
      where: { id },
      data: { ...data, updatedByUserId: actorUserId, version: { increment: 1 } },
      select: RECORD_SELECT,
    });
  }

  async softDelete(tx: Tx, id: string, actorUserId: string): Promise<void> {
    await tx.brand.update({
      where: { id },
      data: { deletedAt: new Date(), updatedByUserId: actorUserId, version: { increment: 1 } },
    });
  }
}
