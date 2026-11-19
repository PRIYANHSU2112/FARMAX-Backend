import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  AttributeDef,
  AttributeRecord,
  ComplianceFlags,
  ComplianceProfileRecord,
  CreateAttributeInput,
  UpdateAttributeInput,
} from './attributes.types.js';

const DEF = {
  id: true,
  categoryId: true,
  key: true,
  label: true,
  dataType: true,
  unit: true,
  options: true,
  isRequired: true,
  isFilterable: true,
  sortOrder: true,
  version: true,
} satisfies Prisma.CategoryAttributeSelect;

const RECORD = {
  ...DEF,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CategoryAttributeSelect;

const PROFILE = {
  id: true,
  categoryId: true,
  requiresRegistration: true,
  requiresDrugLicense: true,
  requiresManufacturingLicense: true,
  requiresWithdrawal: true,
  requiresColdChain: true,
  requiredDocTypes: true,
  allowedSchedules: true,
  version: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ComplianceProfileSelect;

type Client = Cradle['db'] | Tx;

/** Only place that queries `category_attributes` and `product_compliance_profiles`. */
export class AttributesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Live definitions of any of these categories (a path: at most ~10 ids). */
  defsFor(categoryIds: readonly string[], client: Client = this.db): Promise<AttributeDef[]> {
    if (categoryIds.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      client.categoryAttribute.findMany({
        where: { categoryId: { in: [...categoryIds] }, deletedAt: null },
        select: DEF,
      }),
    );
  }

  findLive(id: string, client: Client = this.db): Promise<AttributeRecord | null> {
    return withPrismaErrors(() =>
      client.categoryAttribute.findFirst({ where: { id, deletedAt: null }, select: RECORD }),
    );
  }

  async keyTaken(tx: Tx, categoryId: string, key: string): Promise<boolean> {
    const row = await tx.categoryAttribute.findFirst({
      where: { categoryId, key, deletedAt: null },
      select: { id: true },
    });
    return row !== null;
  }

  create(tx: Tx, input: Omit<CreateAttributeInput, 'reason'>, actorUserId: string) {
    return tx.categoryAttribute.create({
      data: {
        categoryId: input.categoryId,
        key: input.key,
        label: input.label,
        dataType: input.dataType,
        unit: input.unit ?? null,
        options: input.options ?? [],
        isRequired: input.isRequired ?? false,
        isFilterable: input.isFilterable ?? false,
        sortOrder: input.sortOrder ?? 0,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      },
      select: RECORD,
    });
  }

  update(tx: Tx, id: string, data: Omit<UpdateAttributeInput, 'reason'>, actorUserId: string) {
    return tx.categoryAttribute.update({
      where: { id },
      data: { ...data, updatedByUserId: actorUserId, version: { increment: 1 } },
      select: RECORD,
    });
  }

  async softDelete(tx: Tx, id: string, actorUserId: string): Promise<void> {
    await tx.categoryAttribute.update({
      where: { id },
      data: { deletedAt: new Date(), updatedByUserId: actorUserId, version: { increment: 1 } },
    });
  }

  profilesFor(categoryIds: readonly string[], client: Client = this.db) {
    if (categoryIds.length === 0) return Promise.resolve([] as ComplianceProfileRecord[]);
    return withPrismaErrors(() =>
      client.complianceProfile.findMany({
        where: { categoryId: { in: [...categoryIds] }, deletedAt: null },
        select: PROFILE,
      }),
    );
  }

  profileOf(tx: Tx, categoryId: string): Promise<ComplianceProfileRecord | null> {
    return tx.complianceProfile.findFirst({
      where: { categoryId, deletedAt: null },
      select: PROFILE,
    });
  }

  createProfile(tx: Tx, categoryId: string, flags: ComplianceFlags, actorUserId: string) {
    return tx.complianceProfile.create({
      data: { categoryId, ...flags, createdByUserId: actorUserId, updatedByUserId: actorUserId },
      select: PROFILE,
    });
  }

  updateProfile(tx: Tx, id: string, flags: Partial<ComplianceFlags>, actorUserId: string) {
    return tx.complianceProfile.update({
      where: { id },
      data: { ...flags, updatedByUserId: actorUserId, version: { increment: 1 } },
      select: PROFILE,
    });
  }

  async deleteProfile(tx: Tx, id: string, actorUserId: string): Promise<void> {
    await tx.complianceProfile.update({
      where: { id },
      data: { deletedAt: new Date(), updatedByUserId: actorUserId, version: { increment: 1 } },
    });
  }
}
