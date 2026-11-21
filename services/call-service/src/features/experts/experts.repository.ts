import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  AvailabilityInput,
  AvailabilityView,
  CreateExpertInput,
  ExpertListQuery,
  ExpertPatch,
  ExpertView,
  HolidayInput,
  HolidayView,
  TimeOffView,
} from './experts.types.js';

const VIEW = {
  id: true,
  userId: true,
  type: true,
  displayName: true,
  title: true,
  qualification: true,
  photoUrl: true,
  experienceYears: true,
  languages: true,
  brandIds: true,
  categoryIds: true,
  productionTypes: true,
  territoryCodes: true,
  channels: true,
  ratingAvg: true,
  onTimePct: true,
  maxPerDay: true,
  priority: true,
  isBookable: true,
  isActive: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

type Row = Prisma.ExpertGetPayload<{ select: typeof VIEW }>;

const toView = (row: Row): ExpertView => ({
  ...row,
  type: row.type,
  channels: row.channels,
  ratingAvg: row.ratingAvg === null ? null : Number(row.ratingAvg),
});

/** `@db.Date` ⇄ `YYYY-MM-DD` (dates are calendar days, stored at UTC midnight). */
const toDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const fromDate = (date: Date | null): string | null => (date === null ? null : date.toISOString().slice(0, 10));

/** Only place that touches `experts`, their rules / breaks / time-off, and `call_holidays`. */
export class ExpertsRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  async list(query: ExpertListQuery): Promise<Paginated<ExpertView>> {
    const where: Prisma.ExpertWhereInput = {
      deletedAt: null,
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.isBookable === undefined ? {} : { isBookable: query.isBookable }),
      ...(query.brandId === undefined ? {} : { brandIds: { has: query.brandId } }),
      ...(query.categoryId === undefined ? {} : { categoryIds: { has: query.categoryId } }),
      ...(query.q === undefined ? {} : { displayName: { contains: query.q, mode: 'insensitive' } }),
    };
    const rows = await withPrismaErrors(() =>
      this.deps.db.expert.findMany({ where, orderBy: { id: 'desc' }, select: VIEW, ...cursorArgs(query) }),
    );
    return toPage(rows.map(toView), query.limit);
  }

  async findById(id: string, tx?: Tx): Promise<ExpertView | null> {
    const row = await (tx ?? this.deps.db).expert.findFirst({ where: { id, deletedAt: null }, select: VIEW });
    return row === null ? null : toView(row);
  }

  async findManyByIds(ids: readonly string[]): Promise<ExpertView[]> {
    if (ids.length === 0) return [];
    const rows = await this.deps.db.expert.findMany({ where: { id: { in: [...ids] } }, select: VIEW });
    return rows.map(toView);
  }

  async activeIdOfUser(userId: string): Promise<string | null> {
    const row = await this.deps.db.expert.findFirst({
      where: { userId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** Row lock: serialises every change to one expert (and, from step 3, its daily-cap count). */
  async lock(tx: Tx, id: string): Promise<ExpertView | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "experts" WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    return rows.length === 0 ? null : this.findById(id, tx);
  }

  async create(tx: Tx, input: CreateExpertInput & { isBookable: boolean }): Promise<ExpertView> {
    const row = await withPrismaErrors(() =>
      tx.expert.create({
        data: {
          userId: input.userId,
          type: input.type,
          displayName: input.displayName,
          title: input.title ?? null,
          qualification: input.qualification ?? null,
          photoUrl: input.photoUrl ?? null,
          experienceYears: input.experienceYears ?? null,
          languages: input.languages,
          brandIds: input.brandIds ?? [],
          categoryIds: input.categoryIds ?? [],
          productionTypes: input.productionTypes ?? [],
          territoryCodes: input.territoryCodes ?? [],
          channels: input.channels,
          ...(input.maxPerDay === undefined ? {} : { maxPerDay: input.maxPerDay }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          isBookable: input.isBookable,
        },
        select: VIEW,
      }),
    );
    return toView(row);
  }

  /** Applies a patch to a LOCKED row and bumps its version. */
  async update(tx: Tx, id: string, data: ExpertPatch): Promise<ExpertView> {
    const row = await withPrismaErrors(() =>
      tx.expert.update({ where: { id }, data: { ...data, version: { increment: 1 } }, select: VIEW }),
    );
    return toView(row);
  }

  // ── availability ──

  async availability(expertId: string, tx?: Tx): Promise<AvailabilityView> {
    const db = tx ?? this.deps.db;
    const [rules, breaks] = await Promise.all([
      db.expertAvailabilityRule.findMany({
        where: { expertId },
        orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
      }),
      db.expertBreak.findMany({ where: { expertId }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] }),
    ]);
    return {
      rules: rules.map((r) => ({
        id: r.id,
        weekday: r.weekday,
        startMinute: r.startMinute,
        endMinute: r.endMinute,
        channels: r.channels,
        validFrom: fromDate(r.validFrom),
        validTo: fromDate(r.validTo),
      })),
      breaks: breaks.map((b) => ({
        id: b.id,
        weekday: b.weekday,
        startMinute: b.startMinute,
        endMinute: b.endMinute,
      })),
    };
  }

  /** Replace-all (the editor always sends the full week). */
  async replaceAvailability(tx: Tx, expertId: string, input: AvailabilityInput): Promise<void> {
    await tx.expertAvailabilityRule.deleteMany({ where: { expertId } });
    await tx.expertBreak.deleteMany({ where: { expertId } });
    if (input.rules.length > 0)
      await tx.expertAvailabilityRule.createMany({
        data: input.rules.map((r) => ({
          expertId,
          weekday: r.weekday,
          startMinute: r.startMinute,
          endMinute: r.endMinute,
          channels: r.channels ?? [],
          validFrom: r.validFrom == null ? null : toDate(r.validFrom),
          validTo: r.validTo == null ? null : toDate(r.validTo),
        })),
      });
    if (input.breaks.length > 0)
      await tx.expertBreak.createMany({
        data: input.breaks.map((b) => ({
          expertId,
          weekday: b.weekday ?? null,
          startMinute: b.startMinute,
          endMinute: b.endMinute,
        })),
      });
  }

  // ── time-off ──

  timeOffs(expertId: string, endingAfter: Date): Promise<TimeOffView[]> {
    return withPrismaErrors(() =>
      this.deps.db.expertTimeOff.findMany({
        where: { expertId, endAt: { gt: endingAfter } },
        orderBy: { startAt: 'asc' },
        take: 200,
        select: { id: true, startAt: true, endAt: true, reason: true, createdByUserId: true, createdAt: true },
      }),
    );
  }

  createTimeOff(
    tx: Tx,
    expertId: string,
    data: { startAt: Date; endAt: Date; reason: string | null; createdByUserId: string },
  ): Promise<TimeOffView> {
    return tx.expertTimeOff.create({
      data: { expertId, ...data },
      select: { id: true, startAt: true, endAt: true, reason: true, createdByUserId: true, createdAt: true },
    });
  }

  async deleteTimeOff(tx: Tx, expertId: string, id: string): Promise<TimeOffView | null> {
    const row = await tx.expertTimeOff.findFirst({
      where: { id, expertId },
      select: { id: true, startAt: true, endAt: true, reason: true, createdByUserId: true, createdAt: true },
    });
    if (row === null) return null;
    await tx.expertTimeOff.delete({ where: { id } });
    return row;
  }

  // ── holidays ──

  async holidays(from: string, to: string): Promise<HolidayView[]> {
    const rows = await withPrismaErrors(() =>
      this.deps.db.callHoliday.findMany({
        where: { date: { gte: toDate(from), lte: toDate(to) } },
        orderBy: [{ date: 'asc' }, { territoryCode: 'asc' }],
        take: 500,
      }),
    );
    return rows.map((h) => ({ id: h.id, date: fromDate(h.date) ?? '', territoryCode: h.territoryCode, name: h.name }));
  }

  async holidayExists(tx: Tx, date: string, territoryCode: string | null): Promise<boolean> {
    // Serialise duplicate checks for one date (no unique index: territoryCode may be NULL).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`call-holiday:${date}`}))`;
    const n = await tx.callHoliday.count({ where: { date: toDate(date), territoryCode } });
    return n > 0;
  }

  async createHoliday(tx: Tx, input: HolidayInput): Promise<HolidayView> {
    const h = await tx.callHoliday.create({
      data: { date: toDate(input.date), territoryCode: input.territoryCode ?? null, name: input.name },
    });
    return { id: h.id, date: fromDate(h.date) ?? '', territoryCode: h.territoryCode, name: h.name };
  }

  async deleteHoliday(tx: Tx, id: string): Promise<HolidayView | null> {
    const h = await tx.callHoliday.findUnique({ where: { id } });
    if (h === null) return null;
    await tx.callHoliday.delete({ where: { id } });
    return { id: h.id, date: fromDate(h.date) ?? '', territoryCode: h.territoryCode, name: h.name };
  }

  // ── recommendation ──

  /**
   * Active profiles (any type, bookable or not) that match the product at all: brand, a category
   * on its path, or one of the farm's production types. Best priority first, ≤ 50 (GIN-indexed).
   */
  async recommendCandidates(input: {
    brandId: string;
    categoryPath: readonly string[];
    productionTypes: readonly string[];
  }): Promise<ExpertView[]> {
    const rows = await withPrismaErrors(() =>
      this.deps.db.expert.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          OR: [
            { brandIds: { has: input.brandId } },
            ...(input.categoryPath.length === 0 ? [] : [{ categoryIds: { hasSome: [...input.categoryPath] } }]),
            ...(input.productionTypes.length === 0
              ? []
              : [{ productionTypes: { hasSome: [...input.productionTypes] } }]),
          ],
        },
        orderBy: [{ priority: 'desc' }, { id: 'asc' }],
        take: 50,
        select: VIEW,
      }),
    );
    return rows.map(toView);
  }
}
