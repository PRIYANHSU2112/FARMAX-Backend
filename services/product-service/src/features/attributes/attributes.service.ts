import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import { EMPTY_FLAGS, effectiveAttributes, mergeCompliance } from './attributes.rules.js';
import type {
  AttributeRecord,
  ComplianceFlags,
  ComplianceProfileRecord,
  CreateAttributeInput,
  EffectiveAttribute,
  PutComplianceProfileInput,
  UpdateAttributeInput,
} from './attributes.types.js';

type Deps = Pick<
  Cradle,
  'attributesRepository' | 'catalogClient' | 'runInTransaction' | 'auditService'
>;

const versionConflict = (current: number) =>
  new ConflictError('Changed by someone else; reload and retry', {
    details: { reason: 'VERSION_CONFLICT', currentVersion: current },
  });

const CHOICE_TYPES = new Set(['SELECT', 'MULTI_SELECT']);

const checkOptions = (dataType: string, options: string[] | undefined) => {
  const needs = CHOICE_TYPES.has(dataType);
  if (needs && (options === undefined || options.length === 0))
    throw new ValidationError([{ path: 'options', message: 'Required for SELECT / MULTI_SELECT' }]);
  if (!needs && options !== undefined && options.length > 0)
    throw new ValidationError([{ path: 'options', message: `Not allowed for ${dataType}` }]);
};

/**
 * Dynamic per-category attributes and compliance profiles. Both are inherited down the category
 * path (catalog-service owns the tree; we read it through `catalogClient`).
 */
export class AttributesService {
  constructor(private readonly deps: Deps) {}

  private async pathOf(categoryId: string, fresh = false): Promise<string[]> {
    const ctx = await this.deps.catalogClient.categoryContext(categoryId, { fresh });
    if (ctx === null) throw new NotFoundError('Category');
    return ctx.pathIds;
  }

  // ── Used by the products feature (inside its write transaction) ──

  async effectiveFor(pathIds: readonly string[], tx?: Tx): Promise<EffectiveAttribute[]> {
    return effectiveAttributes(pathIds, await this.deps.attributesRepository.defsFor(pathIds, tx));
  }

  async complianceFor(pathIds: readonly string[], tx?: Tx): Promise<ComplianceFlags> {
    return mergeCompliance(await this.deps.attributesRepository.profilesFor(pathIds, tx));
  }

  // ── Admin: attributes ──

  async forCategory(
    categoryId: string,
  ): Promise<{ own: EffectiveAttribute[]; effective: EffectiveAttribute[] }> {
    const effective = await this.effectiveFor(await this.pathOf(categoryId));
    return { own: effective.filter((a) => !a.inherited), effective };
  }

  async create(input: CreateAttributeInput, actor: Actor): Promise<AttributeRecord> {
    const { reason, ...fields } = input;
    checkOptions(fields.dataType, fields.options);
    await this.pathOf(fields.categoryId, true);
    return this.deps.runInTransaction(async (tx) => {
      if (await this.deps.attributesRepository.keyTaken(tx, fields.categoryId, fields.key)) {
        throw new ConflictError(`Attribute "${fields.key}" already exists on this category`, {
          details: { reason: 'ATTRIBUTE_DUPLICATE', fields: ['key'] },
        });
      }
      const created = await this.deps.attributesRepository.create(tx, fields, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'attribute.create',
        targetType: 'attribute',
        targetId: created.id,
        after: created,
        reason,
      });
      return created;
    });
  }

  async update(
    id: string,
    input: UpdateAttributeInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<AttributeRecord> {
    const { reason, ...changes } = input;
    return this.deps.runInTransaction(async (tx) => {
      const current = await this.liveAttribute(tx, id, ifMatch);
      if (changes.options !== undefined) checkOptions(current.dataType, changes.options);
      const updated = await this.deps.attributesRepository.update(tx, id, changes, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'attribute.update',
        targetType: 'attribute',
        targetId: id,
        before: current,
        after: changes,
        reason,
      });
      return updated;
    });
  }

  async remove(id: string, reason: string, ifMatch: number | undefined, actor: Actor) {
    await this.deps.runInTransaction(async (tx) => {
      const current = await this.liveAttribute(tx, id, ifMatch);
      await this.deps.attributesRepository.softDelete(tx, id, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'attribute.delete',
        targetType: 'attribute',
        targetId: id,
        before: current,
        reason,
      });
    });
  }

  // ── Admin: compliance profiles ──

  async profileForCategory(
    categoryId: string,
  ): Promise<{ own: ComplianceProfileRecord | null; effective: ComplianceFlags }> {
    const pathIds = await this.pathOf(categoryId);
    const profiles = await this.deps.attributesRepository.profilesFor(pathIds);
    return {
      own: profiles.find((p) => p.categoryId === categoryId) ?? null,
      effective: mergeCompliance(profiles),
    };
  }

  async putProfile(
    categoryId: string,
    input: PutComplianceProfileInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<ComplianceProfileRecord> {
    const { reason, ...flags } = input;
    await this.pathOf(categoryId, true);
    return this.deps.runInTransaction(async (tx) => {
      const current = await this.deps.attributesRepository.profileOf(tx, categoryId);
      if (current !== null && ifMatch !== undefined && ifMatch !== current.version)
        throw versionConflict(current.version);
      const saved =
        current === null
          ? await this.deps.attributesRepository.createProfile(
              tx,
              categoryId,
              { ...EMPTY_FLAGS, ...flags },
              actor.userId,
            )
          : await this.deps.attributesRepository.updateProfile(tx, current.id, flags, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: current === null ? 'compliance_profile.create' : 'compliance_profile.update',
        targetType: 'compliance_profile',
        targetId: categoryId,
        before: current,
        after: flags,
        reason,
      });
      return saved;
    });
  }

  async removeProfile(categoryId: string, reason: string, actor: Actor): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      const current = await this.deps.attributesRepository.profileOf(tx, categoryId);
      if (current === null) throw new NotFoundError('Compliance profile');
      await this.deps.attributesRepository.deleteProfile(tx, current.id, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'compliance_profile.delete',
        targetType: 'compliance_profile',
        targetId: categoryId,
        before: current,
        reason,
      });
    });
  }

  private async liveAttribute(tx: Tx, id: string, ifMatch: number | undefined) {
    const row = await this.deps.attributesRepository.findLive(id, tx);
    if (row === null) throw new NotFoundError('Attribute');
    if (ifMatch !== undefined && ifMatch !== row.version) throw versionConflict(row.version);
    return row;
  }
}
