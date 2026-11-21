import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  CreateLookupInput,
  LookupGroup,
  LookupListQuery,
  LookupRecord,
  LookupRow,
  UpdateLookupInput,
} from './lookups.types.js';

const ROW = {
  id: true,
  group: true,
  code: true,
  label: true,
  description: true,
  meta: true,
  isActive: true,
  sortOrder: true,
  version: true,
} satisfies Prisma.ProductLookupSelect;

const RECORD = {
  ...ROW,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductLookupSelect;

const ORDER: Prisma.ProductLookupOrderByWithRelationInput[] = [
  { group: 'asc' },
  { sortOrder: 'asc' },
  { label: 'asc' },
];

type Client = Cradle['db'] | Tx;
const asRecord = <T>(row: T) => row as unknown as T & { meta: Record<string, unknown> };

/** Only place that queries `product_lookups`. */
export class LookupsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async list(query: LookupListQuery): Promise<LookupRecord[]> {
    const q = query.q?.trim();
    const rows = await withPrismaErrors(() =>
      this.db.productLookup.findMany({
        where: {
          deletedAt: null,
          ...(query.group === undefined ? {} : { group: query.group }),
          ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
          ...(q === undefined || q === ''
            ? {}
            : {
                OR: [
                  { label: { contains: q, mode: 'insensitive' } },
                  { code: { contains: q.toUpperCase() } },
                ],
              }),
        },
        select: RECORD,
        orderBy: ORDER,
      }),
    );
    return rows.map((r) => asRecord(r) as LookupRecord);
  }

  async activeAll(): Promise<LookupRow[]> {
    const rows = await withPrismaErrors(() =>
      this.db.productLookup.findMany({
        where: { deletedAt: null, isActive: true },
        select: ROW,
        orderBy: ORDER,
      }),
    );
    return rows.map((r) => asRecord(r) as LookupRow);
  }

  async findLive(id: string, client: Client = this.db): Promise<LookupRecord | null> {
    const row = await withPrismaErrors(() =>
      client.productLookup.findFirst({ where: { id, deletedAt: null }, select: RECORD }),
    );
    return row === null ? null : asRecord(row);
  }

  async findByIds(tx: Tx, ids: readonly string[]): Promise<LookupRow[]> {
    if (ids.length === 0) return [];
    const rows = await tx.productLookup.findMany({
      where: { id: { in: [...ids] }, deletedAt: null },
      select: ROW,
    });
    return rows.map((r) => asRecord(r) as LookupRow);
  }

  async findByCodes(tx: Tx, group: LookupGroup, codes: readonly string[]): Promise<LookupRow[]> {
    if (codes.length === 0) return [];
    const rows = await tx.productLookup.findMany({
      where: { group, code: { in: [...codes] }, deletedAt: null },
      select: ROW,
    });
    return rows.map((r) => asRecord(r) as LookupRow);
  }

  async codeTaken(tx: Tx, group: LookupGroup, code: string): Promise<boolean> {
    const row = await tx.productLookup.findFirst({
      where: { group, code, deletedAt: null },
      select: { id: true },
    });
    return row !== null;
  }

  /** Products, routes, species, ingredients and variants referencing the lookup. */
  async usageCount(
    tx: Tx,
    { id, group, code }: Pick<LookupRow, 'id' | 'group' | 'code'>,
  ): Promise<number> {
    // FLOCK_STAGE values are referenced by code inside products.productionStages (GIN index).
    if (group === 'FLOCK_STAGE')
      return tx.product.count({ where: { productionStages: { has: code }, deletedAt: null } });
    const [forms, routes, species, ingredients, perUnits, variants] = await Promise.all([
      tx.product.count({ where: { dosageFormId: id, deletedAt: null } }),
      tx.productRoute.count({ where: { lookupId: id } }),
      tx.productSpecies.count({ where: { lookupId: id } }),
      tx.productIngredient.count({ where: { unitId: id } }),
      tx.productIngredient.count({ where: { perUnitId: id } }),
      tx.productVariant.count({ where: { packUnitId: id, deletedAt: null } }),
    ]);
    return forms + routes + species + ingredients + perUnits + variants;
  }

  async create(
    tx: Tx,
    input: Omit<CreateLookupInput, 'reason'>,
    actorUserId: string,
  ): Promise<LookupRecord> {
    const row = await tx.productLookup.create({
      data: {
        group: input.group,
        code: input.code,
        label: input.label,
        description: input.description ?? null,
        meta: (input.meta ?? {}) as Prisma.InputJsonValue,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      },
      select: RECORD,
    });
    return asRecord(row);
  }

  async update(
    tx: Tx,
    id: string,
    data: Omit<UpdateLookupInput, 'reason'>,
    actorUserId: string,
  ): Promise<LookupRecord> {
    const { meta, ...rest } = data;
    const row = await tx.productLookup.update({
      where: { id },
      data: {
        ...rest,
        ...(meta === undefined ? {} : { meta: meta as Prisma.InputJsonValue }),
        updatedByUserId: actorUserId,
        version: { increment: 1 },
      },
      select: RECORD,
    });
    return asRecord(row);
  }

  async softDelete(tx: Tx, id: string, actorUserId: string): Promise<void> {
    await tx.productLookup.update({
      where: { id },
      data: { deletedAt: new Date(), updatedByUserId: actorUserId, version: { increment: 1 } },
    });
  }
}
