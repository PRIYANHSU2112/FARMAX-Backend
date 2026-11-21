import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  CreateDiseaseInput,
  DiseaseListQuery,
  DiseaseRecord,
  UpdateDiseaseInput,
} from './diseases.types.js';

const RECORD = {
  id: true,
  name: true,
  slug: true,
  description: true,
  iconUrl: true,
  iconMediaId: true,
  sortOrder: true,
  isActive: true,
  version: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DiseaseSelect;

const ORDER: Prisma.DiseaseOrderByWithRelationInput[] = [{ sortOrder: 'asc' }, { name: 'asc' }];
const LIVE = { deletedAt: null } as const;

type Client = Cradle['db'] | Tx;
type Fields = Omit<CreateDiseaseInput, 'reason' | 'slug'> & { slug: string };

/** Only place that queries `diseases` / `product_diseases`. */
export class DiseasesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  list(query: DiseaseListQuery): Promise<DiseaseRecord[]> {
    const q = query.q?.trim();
    return withPrismaErrors(() =>
      this.db.disease.findMany({
        where: {
          ...LIVE,
          ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
          ...(q === undefined || q === ''
            ? {}
            : {
                OR: [
                  { name: { contains: q, mode: 'insensitive' } },
                  { slug: { contains: q.toLowerCase() } },
                ],
              }),
        },
        select: RECORD,
        orderBy: ORDER,
      }),
    );
  }

  activeAll(): Promise<DiseaseRecord[]> {
    return withPrismaErrors(() =>
      this.db.disease.findMany({
        where: { ...LIVE, isActive: true },
        select: RECORD,
        orderBy: ORDER,
      }),
    );
  }

  findLive(id: string, client: Client = this.db): Promise<DiseaseRecord | null> {
    return withPrismaErrors(() =>
      client.disease.findFirst({ where: { id, ...LIVE }, select: RECORD }),
    );
  }

  /** Live + active disease id for a storefront slug (a deleted disease's slug never resolves). */
  async activeIdsBySlugs(slugs: readonly string[]): Promise<string[]> {
    if (slugs.length === 0) return [];
    const rows = await withPrismaErrors(() =>
      this.db.disease.findMany({
        where: { slug: { in: [...slugs] }, ...LIVE, isActive: true },
        select: { id: true },
      }),
    );
    return rows.map((r) => r.id);
  }

  findByIds(tx: Tx, ids: readonly string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return tx.disease.findMany({
      where: { id: { in: [...ids] }, ...LIVE },
      select: { id: true, name: true, isActive: true },
    });
  }

  async slugTaken(tx: Tx, slug: string, exceptId?: string): Promise<boolean> {
    const row = await tx.disease.findFirst({
      where: { slug, ...LIVE, ...(exceptId === undefined ? {} : { id: { not: exceptId } }) },
      select: { id: true },
    });
    return row !== null;
  }

  /** Live slugs equal to `base` or `base-<n>` (auto-slug picks the first free one). */
  async slugsLike(tx: Tx, base: string): Promise<Set<string>> {
    const rows = await tx.disease.findMany({
      where: { slug: { startsWith: base }, ...LIVE },
      select: { slug: true },
    });
    return new Set(rows.map((r) => r.slug));
  }

  async nameTaken(tx: Tx, name: string, exceptId?: string): Promise<boolean> {
    const row = await tx.disease.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...LIVE,
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return row !== null;
  }

  /** Links to live, active products — these block a delete. */
  activeProductCount(tx: Tx, id: string): Promise<number> {
    return tx.productDisease.count({
      where: { diseaseId: id, product: { ...LIVE, isActive: true } },
    });
  }

  /** Slugs of live products linked to the disease (their detail cache shows its name/icon). */
  async linkedProductSlugs(id: string): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.productDisease.findMany({
        where: { diseaseId: id, product: LIVE },
        select: { product: { select: { slug: true } } },
      }),
    );
    return rows.map((r) => r.product.slug);
  }

  /** Product count per disease among products matching `productWhere` (storefront visibility). */
  async productCounts(productWhere: Prisma.ProductWhereInput): Promise<Map<string, number>> {
    const rows = await withPrismaErrors(() =>
      this.db.productDisease.groupBy({
        by: ['diseaseId'],
        where: { product: productWhere, disease: { ...LIVE, isActive: true } },
        _count: { _all: true },
      }),
    );
    return new Map(rows.map((r) => [r.diseaseId, r._count._all]));
  }

  create(tx: Tx, input: Fields, actorUserId: string): Promise<DiseaseRecord> {
    return tx.disease.create({
      data: {
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        iconUrl: input.iconUrl ?? null,
        iconMediaId: input.iconMediaId ?? null,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      },
      select: RECORD,
    });
  }

  update(
    tx: Tx,
    id: string,
    data: Omit<UpdateDiseaseInput, 'reason'>,
    actorUserId: string,
  ): Promise<DiseaseRecord> {
    return tx.disease.update({
      where: { id },
      data: { ...data, updatedByUserId: actorUserId, version: { increment: 1 } },
      select: RECORD,
    });
  }

  /** Soft delete only: the row and its product links stay as history. */
  async softDelete(tx: Tx, id: string, actorUserId: string): Promise<void> {
    await tx.disease.update({
      where: { id },
      data: { deletedAt: new Date(), updatedByUserId: actorUserId, version: { increment: 1 } },
    });
  }
}
