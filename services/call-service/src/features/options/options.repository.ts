import { type Tx, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { CreateOptionInput, OptionType, OptionView } from './options.types.js';

const VIEW = {
  id: true,
  type: true,
  code: true,
  label: true,
  icon: true,
  sortOrder: true,
  isActive: true,
  meta: true,
  updatedAt: true,
} as const;

const toView = (row: Prisma.CallOptionGetPayload<{ select: typeof VIEW }>): OptionView => ({
  ...row,
  meta: (row.meta ?? null) as Record<string, unknown> | null,
});

const ORDER = [{ type: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }] as const;

/** Only place that touches `call_options` and `call_settings`. */
export class OptionsRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  async list(filter: { type?: OptionType; activeOnly?: boolean }): Promise<OptionView[]> {
    const rows = await withPrismaErrors(() =>
      this.deps.db.callOption.findMany({
        where: {
          ...(filter.type === undefined ? {} : { type: filter.type }),
          ...(filter.activeOnly === true ? { isActive: true } : {}),
        },
        orderBy: [...ORDER],
        select: VIEW,
      }),
    );
    return rows.map(toView);
  }

  async findForUpdate(tx: Tx, id: string): Promise<OptionView | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "call_options" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) return null;
    const row = await tx.callOption.findUnique({ where: { id }, select: VIEW });
    return row === null ? null : toView(row);
  }

  /** Serialises "last active of a type" checks: lock every row of the type. */
  async countActiveLocked(tx: Tx, type: OptionType): Promise<number> {
    const rows = await tx.$queryRaw<{ isActive: boolean }[]>`
      SELECT "isActive" FROM "call_options" WHERE "type" = ${type}::"CallOptionType" FOR UPDATE`;
    return rows.filter((r) => r.isActive).length;
  }

  async create(tx: Tx, input: CreateOptionInput): Promise<OptionView> {
    const row = await withPrismaErrors(() =>
      tx.callOption.create({
        data: {
          type: input.type,
          code: input.code,
          label: input.label,
          icon: input.icon ?? null,
          sortOrder: input.sortOrder ?? 0,
          ...(input.meta == null ? {} : { meta: input.meta as Prisma.InputJsonValue }),
        },
        select: VIEW,
      }),
    );
    return toView(row);
  }

  async update(
    tx: Tx,
    id: string,
    patch: Omit<Partial<OptionView>, 'id' | 'type' | 'code' | 'updatedAt'>,
  ): Promise<OptionView> {
    const { meta, ...rest } = patch;
    const row = await tx.callOption.update({
      where: { id },
      data: {
        ...rest,
        ...(meta === undefined
          ? {}
          : { meta: meta === null ? Prisma.DbNull : (meta as Prisma.InputJsonValue) }),
      },
      select: VIEW,
    });
    return toView(row);
  }

  // ── settings ──

  allSettings(): Promise<{ key: string; value: unknown; updatedByUserId: string | null; updatedAt: Date }[]> {
    return withPrismaErrors(() =>
      this.deps.db.callSetting.findMany({
        orderBy: { key: 'asc' },
        select: { key: true, value: true, updatedByUserId: true, updatedAt: true },
      }),
    );
  }

  async settingForUpdate(tx: Tx, key: string): Promise<{ value: unknown } | null> {
    const rows = await tx.$queryRaw<{ value: unknown }[]>`
      SELECT "value" FROM "call_settings" WHERE "key" = ${key} FOR UPDATE`;
    return rows[0] ?? null;
  }

  async upsertSetting(tx: Tx, key: string, value: unknown, userId: string | null): Promise<Date> {
    const row = await tx.callSetting.upsert({
      where: { key },
      create: { key, value: value as Prisma.InputJsonValue, updatedByUserId: userId },
      update: { value: value as Prisma.InputJsonValue, updatedByUserId: userId },
      select: { updatedAt: true },
    });
    return row.updatedAt;
  }
}
