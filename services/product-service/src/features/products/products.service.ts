import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { type Tx, isUniqueViolation, mapPrismaError, uniqueViolationFields } from '@farmx/database';
import type { VariantFactsV1 } from '@farmx/infra/events';
import { productKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { emitProductEvent } from '../../adapters/events.js';
import { uuidv7 } from '../../adapters/uuid.js';
import { validateAttributeValues } from '../attributes/index.js';
import type { Actor, AuditRecord } from '../audit/index.js';
import type { LookupGroup, LookupRow, SpeciesMeta } from './lookups.types.js';
import {
  type ComplianceSubject,
  checkCompliance,
  normalizeRegulatory,
} from './products.compliance.js';
import {
  buildSearchText,
  firstFreeSlug,
  pickDefaultIndex,
  pickPromotion,
  priceSummary,
  productCodeOf,
  slugify,
} from './products.helpers.js';
import type { ProductData, ProductRecord, VariantRecord } from './products.repository.js';
import {
  type StatusAction,
  TRANSITIONS,
  isDeletable,
  isEditable,
  nextStatus,
} from './products.status.js';
import type {
  AdminListQuery,
  AdminProductRow,
  ComplianceIssue,
  CreateProductInput,
  MediaInput,
  MediaView,
  ProductFields,
  ProductView,
  UpdateMediaInput,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInput,
} from './products.types.js';
import { toProductView } from './products.views.js';

type Deps = Pick<
  Cradle,
  | 'productsRepository'
  | 'lookupsService'
  | 'diseasesService'
  | 'attributesService'
  | 'catalogClient'
  | 'runInTransaction'
  | 'auditService'
  | 'redis'
  | 'logger'
>;

type RefType = 'CATEGORY' | 'BRAND';

const versionConflict = (current: number) =>
  new ConflictError('The product was changed by someone else; reload and retry', {
    details: { reason: 'VERSION_CONFLICT', currentVersion: current },
  });

const duplicate = (fields: string[]) =>
  new ConflictError(`Already in use: ${fields.join(', ')}`, {
    details: { reason: 'PRODUCT_DUPLICATE', fields },
  });

const lastVariant = () =>
  new ConflictError('A product must keep at least one active variant', {
    details: { reason: 'LAST_VARIANT' },
  });

const complianceFailed = (issues: ComplianceIssue[]) =>
  new ValidationError(
    issues.map((i) => ({ path: i.path, message: `[${i.rule}] ${i.message}` })),
    'Regulatory requirements not met',
  );

const nonEmpty = (v: string | null | undefined) =>
  v === undefined || v === null || v.trim() === '' ? null : v;

/** Input keys written through relations / special handling, never as plain columns. */
const RELATION_KEYS = new Set([
  'ingredients',
  'routeIds',
  'speciesIds',
  'diseaseIds',
  'attributes',
  'slug',
]);

/** Fields that inventory / logistics consume: a change re-emits variant facts. */
const FACT_FIELDS = new Set([
  'name',
  'manufacturerName',
  'isPrescriptionRequired',
  'temperatureClass',
  'shelfLifeMonths',
  'drugSchedule',
  'isAntimicrobial',
  'categoryId',
  'brandId',
]);

/**
 * Admin side of products: create/update with ingredients, routes, species and variants; the
 * default-variant invariant; media; the status workflow with the regulatory matrix; the safe
 * category/brand delete protocol. Every write = one transaction + audit row + outbox events;
 * caches are dropped after commit.
 */
export class ProductsService {
  constructor(private readonly deps: Deps) {}

  private get repo() {
    return this.deps.productsRepository;
  }

  // ── Reads ──

  async list(query: AdminListQuery): Promise<Paginated<AdminProductRow>> {
    let categoryIds: string[] | undefined;
    if (query.categoryId !== undefined) {
      const ctx = await this.deps.catalogClient.categoryContext(query.categoryId);
      categoryIds = ctx?.subtreeIds ?? [query.categoryId];
    }
    const page = await this.repo.adminList(query, categoryIds);
    return {
      ...page,
      items: page.items.map(({ _count, variants, ...row }) => ({
        ...row,
        variantCount: _count.variants,
        defaultSku: variants[0]?.sku ?? null,
      })),
    };
  }

  async detail(id: string): Promise<ProductView> {
    const record = await this.repo.findDetail(id);
    if (record === null) throw new NotFoundError('Product');
    return toProductView(record, await this.stageLabels());
  }

  /** FLOCK_STAGE code → label (cached active lookups). */
  async stageLabels(): Promise<Map<string, string>> {
    const stages = await this.deps.lookupsService.publicList('FLOCK_STAGE');
    return new Map(stages.map((s) => [s.code, s.label]));
  }

  history(id: string, query: { cursor?: string; limit: number }): Promise<Paginated<AuditRecord>> {
    return this.deps.auditService.history('product', id, query);
  }

  /** Dry-run of the publish rules (for the admin form). */
  async complianceReport(id: string): Promise<{ ok: boolean; issues: ComplianceIssue[] }> {
    const record = await this.repo.findDetail(id);
    if (record === null) throw new NotFoundError('Product');
    const issues = await this.evaluate(record);
    return { ok: issues.length === 0, issues };
  }

  // ── Create / update ──

  async create(input: CreateProductInput, actor: Actor): Promise<ProductView> {
    const {
      reason,
      variants,
      ingredients = [],
      routeIds = [],
      speciesIds = [],
      diseaseIds = [],
      attributes = {},
      slug: wantedSlug,
      ...fields
    } = input;
    const defaultIndex = pickDefaultIndex(variants);
    if (typeof defaultIndex === 'string')
      throw new ValidationError([{ path: 'variants', message: defaultIndex }]);
    this.assertUniqueWithin(variants);

    const category = await this.deps.catalogClient.assertAssignableCategory(fields.categoryId);
    const brand = await this.deps.catalogClient.assertAssignableBrand(fields.brandId);
    await this.assertAttributes(category.pathIds, attributes, false);

    const id = await this.write(async (tx) => {
      await this.assertReferencesOpen(tx, fields.categoryId, fields.brandId);
      await this.resolveLookups(tx, {
        dosageFormId: fields.dosageFormId,
        routeIds,
        speciesIds,
        productionStages: fields.productionStages,
        ingredients,
        variants,
      });
      await this.deps.diseasesService.assertLinkable(tx, diseaseIds);
      await this.assertVariantKeysFree(tx, variants);
      const slug = await this.chooseSlug(tx, fields.name, wantedSlug);
      const productCode = productCodeOf(await this.repo.nextProductSeq(tx));
      const regulatory = normalizeRegulatory({
        drugSchedule: fields.drugSchedule ?? 'OTC',
        isAntimicrobial: fields.isAntimicrobial ?? false,
        isPrescriptionRequired: fields.isPrescriptionRequired ?? false,
        isVetConsultRequired: fields.isVetConsultRequired ?? false,
      });
      const productId = uuidv7();
      const data: ProductData & { id: string } = {
        ...(this.scalarData(fields) as ProductData),
        ...regulatory,
        id: productId,
        slug,
        productCode,
        brandName: brand.name,
        attributes: attributes as object,
        searchText: buildSearchText({
          name: fields.name,
          genericName: nonEmpty(fields.genericName),
          brandName: brand.name,
          productCode,
          manufacturerName: nonEmpty(fields.manufacturerName),
          tags: fields.tags ?? [],
          ingredientNames: ingredients.map((i) => i.name),
        }),
      };
      await this.repo.create(
        tx,
        data,
        {
          routeIds,
          speciesIds,
          diseaseIds,
          ingredients,
          variants: variants.map((v, i) => ({ ...v, isDefault: i === defaultIndex })),
        },
        actor.userId,
      );
      const created = await this.loadOrThrow(tx, productId);
      await this.deps.auditService.record(tx, actor, {
        action: 'product.create',
        targetType: 'product',
        targetId: productId,
        after: { ...data, variants, ingredients, routeIds, speciesIds, diseaseIds },
        reason,
      });
      const createdPath = await this.categoryPath(created.categoryId);
      for (const v of created.variants)
        await emitProductEvent(
          tx,
          'product.variant_created.v1',
          this.facts(created, v, createdPath),
          actor.requestId,
        );
      return productId;
    });
    return this.afterWrite(id);
  }

  async update(
    id: string,
    input: UpdateProductInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<ProductView> {
    const { reason, ingredients, routeIds, speciesIds, diseaseIds, attributes, slug, ...fields } =
      input;
    const before = await this.repo.findDetail(id);
    if (before === null) throw new NotFoundError('Product');
    const categoryId = fields.categoryId ?? before.categoryId;
    const category =
      fields.categoryId !== undefined && fields.categoryId !== before.categoryId
        ? await this.deps.catalogClient.assertAssignableCategory(fields.categoryId)
        : await this.deps.catalogClient.categoryContext(categoryId);
    const brand =
      fields.brandId !== undefined && fields.brandId !== before.brandId
        ? await this.deps.catalogClient.assertAssignableBrand(fields.brandId)
        : null;
    const nextAttributes = attributes ?? (before.attributes as Record<string, unknown>);
    await this.assertAttributes(category?.pathIds ?? [categoryId], nextAttributes, false);

    await this.write(async (tx) => {
      const current = await this.lockAndLoad(tx, id, ifMatch);
      if (!isEditable(current.status))
        throw new ConflictError('A discontinued product cannot be edited', {
          details: { reason: 'NOT_EDITABLE', status: current.status },
        });
      if (fields.categoryId !== undefined || fields.brandId !== undefined)
        await this.assertReferencesOpen(tx, fields.categoryId, fields.brandId);
      await this.resolveLookups(tx, {
        dosageFormId: fields.dosageFormId,
        routeIds,
        speciesIds,
        productionStages: fields.productionStages,
        ingredients,
        variants: [],
      });
      if (diseaseIds !== undefined) await this.deps.diseasesService.assertLinkable(tx, diseaseIds);
      const nextSlug =
        slug === undefined || slug === current.slug
          ? undefined
          : (await this.repo.slugTaken(tx, slug, id))
            ? (() => {
                throw duplicate(['slug']);
              })()
            : slug;
      const merged = { ...current, ...fields };
      const regulatory = normalizeRegulatory({
        drugSchedule: merged.drugSchedule,
        isAntimicrobial: merged.isAntimicrobial,
        isPrescriptionRequired: merged.isPrescriptionRequired,
        isVetConsultRequired: merged.isVetConsultRequired,
      });
      const brandName = brand?.name ?? current.brandName;
      const data: Partial<ProductData> = {
        ...this.scalarData(fields),
        ...regulatory,
        ...(nextSlug === undefined ? {} : { slug: nextSlug }),
        ...(brand === null ? {} : { brandName }),
        ...(attributes === undefined ? {} : { attributes: attributes as object }),
        searchText: buildSearchText({
          name: merged.name,
          genericName: nonEmpty(merged.genericName),
          brandName,
          productCode: current.productCode,
          manufacturerName: nonEmpty(merged.manufacturerName),
          tags: merged.tags,
          ingredientNames: (ingredients ?? current.ingredients).map((i) => i.name),
        }),
      };
      await this.repo.update(
        tx,
        id,
        data,
        { routeIds, speciesIds, diseaseIds, ingredients },
        actor.userId,
      );
      const updated = await this.loadOrThrow(tx, id);
      // A listed product must stay compliant after an edit.
      if (updated.status === 'PUBLISHED' || updated.status === 'PENDING_REVIEW') {
        const issues = await this.evaluate(updated, tx);
        if (issues.length > 0) throw complianceFailed(issues);
      }
      await this.deps.auditService.record(tx, actor, {
        action: 'product.update',
        targetType: 'product',
        targetId: id,
        before: Object.fromEntries(
          Object.keys(input).map((k) => [k, (current as Record<string, unknown>)[k]]),
        ),
        after: { ...data, ingredients, routeIds, speciesIds, diseaseIds },
        reason,
      });
      if (Object.keys(fields).some((k) => FACT_FIELDS.has(k))) {
        const updatedPath = await this.categoryPath(updated.categoryId);
        for (const v of updated.variants)
          await emitProductEvent(
            tx,
            'product.variant_updated.v1',
            this.facts(updated, v, updatedPath),
            actor.requestId,
          );
      }
    });
    return this.afterWrite(id, [before.slug]);
  }

  async setFlags(
    id: string,
    input: { isActive?: boolean; isFeatured?: boolean; reason: string },
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<ProductView> {
    const { reason, ...flags } = input;
    await this.write(async (tx) => {
      const current = await this.lockAndLoad(tx, id, ifMatch);
      await this.repo.touch(tx, id, actor.userId, flags);
      await this.deps.auditService.record(tx, actor, {
        action: 'product.flags',
        targetType: 'product',
        targetId: id,
        before: { isActive: current.isActive, isFeatured: current.isFeatured },
        after: flags,
        reason,
      });
    });
    return this.afterWrite(id);
  }

  async remove(
    id: string,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<void> {
    let slug = '';
    await this.write(async (tx) => {
      const current = await this.lockAndLoad(tx, id, ifMatch);
      if (!isDeletable(current.status))
        throw new ConflictError('Only draft or discontinued products can be deleted', {
          details: { reason: 'NOT_DELETABLE', status: current.status },
        });
      slug = current.slug;
      await this.repo.softDelete(tx, id, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'product.delete',
        targetType: 'product',
        targetId: id,
        before: current,
        reason,
      });
      for (const v of current.variants)
        await emitProductEvent(
          tx,
          'product.variant_deactivated.v1',
          { variantId: v.id, productId: id, version: v.version + 1 },
          actor.requestId,
        );
    });
    await this.invalidate([slug]);
  }

  // ── Status workflow ──

  async transition(
    id: string,
    action: StatusAction,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<ProductView> {
    await this.write(async (tx) => {
      const current = await this.lockAndLoad(tx, id, ifMatch);
      const to = nextStatus(current.status, action);
      if (to === null)
        throw new ConflictError(`Cannot ${action} a ${current.status} product`, {
          details: { reason: 'INVALID_TRANSITION', status: current.status, action },
        });
      if (action === 'approve' && current.submittedByUserId === actor.userId)
        throw new ForbiddenError('The approver must be different from the submitter');
      if (TRANSITIONS[action].checksCompliance) {
        const issues = await this.evaluate(current, tx, true);
        if (issues.length > 0) throw complianceFailed(issues);
      }
      const now = new Date();
      await this.repo.setStatus(
        tx,
        id,
        to,
        action === 'submit'
          ? { submittedAt: now, submittedByUserId: actor.userId }
          : action === 'approve' || action === 'reinstate'
            ? { publishedAt: now, publishedByUserId: actor.userId }
            : {},
        actor.userId,
      );
      await this.deps.auditService.record(tx, actor, {
        action: `product.${action}`,
        targetType: 'product',
        targetId: id,
        before: { status: current.status },
        after: { status: to },
        reason,
      });
      const variantIds = current.variants.map((v) => v.id);
      if (to === 'PUBLISHED')
        await emitProductEvent(
          tx,
          'product.published.v1',
          { productId: id, variantIds, reason },
          actor.requestId,
        );
      else if (current.status === 'PUBLISHED')
        await emitProductEvent(
          tx,
          'product.suspended.v1',
          { productId: id, variantIds, reason },
          actor.requestId,
        );
    });
    return this.afterWrite(id);
  }

  // ── Variants ──

  async addVariant(
    productId: string,
    input: VariantInput & { reason: string },
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<ProductView> {
    const { reason, ...variant } = input;
    if (variant.isDefault === true && variant.isActive === false)
      throw new ValidationError([
        { path: 'isDefault', message: 'The default variant must be active' },
      ]);
    await this.write(async (tx) => {
      const product = await this.lockAndLoad(tx, productId, ifMatch);
      await this.resolveLookups(tx, { variants: [variant] });
      await this.assertVariantKeysFree(tx, [variant]);
      if (variant.isDefault === true) {
        const old = product.variants.find((v) => v.isDefault);
        if (old !== undefined)
          await this.repo.updateVariant(tx, old.id, { isDefault: false }, actor.userId);
      }
      const created = await this.repo.createVariant(
        tx,
        productId,
        { ...variant, sortOrder: variant.sortOrder ?? (product.variants.length + 1) * 10 },
        actor.userId,
      );
      await this.repo.touch(tx, productId, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'variant.create',
        targetType: 'variant',
        targetId: created.id,
        after: { productId, ...variant },
        reason,
      });
      await emitProductEvent(
        tx,
        'product.variant_created.v1',
        this.facts(product, created, await this.categoryPath(product.categoryId)),
        actor.requestId,
      );
    });
    return this.afterWrite(productId);
  }

  async updateVariant(
    productId: string,
    variantId: string,
    input: UpdateVariantInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<ProductView> {
    const { reason, ...changes } = input;
    await this.write(async (tx) => {
      const product = await this.lockAndLoad(tx, productId, undefined);
      const variant = this.variantOf(product, variantId);
      if (ifMatch !== undefined && ifMatch !== variant.version)
        throw versionConflict(variant.version);
      if (changes.packUnitId !== undefined)
        await this.resolveLookups(tx, {
          variants: [{ ...changes, packUnitId: changes.packUnitId }],
        });
      if (changes.sku !== undefined || changes.barcode !== undefined)
        await this.assertVariantKeysFree(tx, [changes], variantId);
      // Deactivating the default promotes another active variant (or refuses the last one).
      let promote: VariantRecord | undefined;
      if (changes.isActive === false && variant.isActive) {
        const others = product.variants.filter((v) => v.id !== variantId && v.isActive);
        if (others.length === 0) throw lastVariant();
        if (variant.isDefault) promote = pickPromotion(product.variants, variantId);
      }
      const updated = await this.repo.updateVariant(
        tx,
        variantId,
        { ...changes, ...(promote === undefined ? {} : { isDefault: false }) },
        actor.userId,
      );
      if (promote !== undefined)
        await this.repo.updateVariant(tx, promote.id, { isDefault: true }, actor.userId);
      await this.refreshPriceSummary(tx, productId);
      await this.repo.touch(tx, productId, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'variant.update',
        targetType: 'variant',
        targetId: variantId,
        before: Object.fromEntries(
          Object.keys(changes).map((k) => [k, (variant as Record<string, unknown>)[k]]),
        ),
        after: { ...changes, ...(promote === undefined ? {} : { promotedDefault: promote.id }) },
        reason,
      });
      const type =
        changes.isActive === false
          ? 'product.variant_deactivated.v1'
          : 'product.variant_updated.v1';
      if (type === 'product.variant_deactivated.v1')
        await emitProductEvent(
          tx,
          type,
          { variantId, productId, version: updated.version },
          actor.requestId,
        );
      else
        await emitProductEvent(
          tx,
          type,
          this.facts(product, updated, await this.categoryPath(product.categoryId)),
          actor.requestId,
        );
    });
    return this.afterWrite(productId);
  }

  async setDefaultVariant(
    productId: string,
    variantId: string,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<ProductView> {
    await this.write(async (tx) => {
      const product = await this.lockAndLoad(tx, productId, ifMatch);
      const target = this.variantOf(product, variantId);
      if (!target.isActive)
        throw new ValidationError([
          { path: 'variantId', message: 'The default variant must be active' },
        ]);
      if (target.isDefault) return;
      const old = product.variants.find((v) => v.isDefault);
      // Unset first: the partial unique index allows at most one live default.
      if (old !== undefined)
        await this.repo.updateVariant(tx, old.id, { isDefault: false }, actor.userId);
      await this.repo.updateVariant(tx, variantId, { isDefault: true }, actor.userId);
      await this.repo.touch(tx, productId, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'variant.default',
        targetType: 'product',
        targetId: productId,
        before: { defaultVariantId: old?.id ?? null },
        after: { defaultVariantId: variantId },
        reason,
      });
    });
    return this.afterWrite(productId);
  }

  async removeVariant(
    productId: string,
    variantId: string,
    opts: { reason: string; newDefaultVariantId?: string },
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<ProductView> {
    await this.write(async (tx) => {
      const product = await this.lockAndLoad(tx, productId, ifMatch);
      const variant = this.variantOf(product, variantId);
      const remainingActive = product.variants.filter((v) => v.id !== variantId && v.isActive);
      if (remainingActive.length === 0) throw lastVariant();
      let promote: VariantRecord | undefined;
      if (variant.isDefault) {
        promote = pickPromotion(product.variants, variantId, opts.newDefaultVariantId);
        if (promote === undefined)
          throw new ValidationError([
            {
              path: 'newDefaultVariantId',
              message: 'Must be another active variant of this product',
            },
          ]);
      }
      await this.repo.softDeleteVariant(tx, variantId, actor.userId);
      if (promote !== undefined)
        await this.repo.updateVariant(tx, promote.id, { isDefault: true }, actor.userId);
      await this.refreshPriceSummary(tx, productId);
      await this.repo.touch(tx, productId, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'variant.delete',
        targetType: 'variant',
        targetId: variantId,
        before: variant,
        after: promote === undefined ? null : { promotedDefault: promote.id },
        reason: opts.reason,
      });
      await emitProductEvent(
        tx,
        'product.variant_deactivated.v1',
        { variantId, productId, version: variant.version + 1 },
        actor.requestId,
      );
    });
    return this.afterWrite(productId);
  }

  // ── Media ──

  async addMedia(productId: string, input: MediaInput, actor: Actor): Promise<MediaView> {
    const { reason, ...media } = input;
    const created = await this.write(async (tx) => {
      const product = await this.lockAndLoad(tx, productId, undefined);
      if (media.variantId !== undefined && media.variantId !== null)
        this.variantOf(product, media.variantId);
      if (media.kind === 'IMAGE' && media.isPrimary === true)
        await this.repo.unsetPrimary(tx, productId);
      const row = await this.repo.createMedia(tx, productId, media, actor.userId);
      await this.repo.touch(tx, productId, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'media.create',
        targetType: 'media',
        targetId: row.id,
        after: { productId, ...media },
        reason,
      });
      return row;
    });
    await this.invalidate([], productId);
    return created;
  }

  async updateMedia(
    productId: string,
    mediaId: string,
    input: UpdateMediaInput,
    actor: Actor,
  ): Promise<MediaView> {
    const { reason, ...changes } = input;
    const updated = await this.write(async (tx) => {
      await this.lockAndLoad(tx, productId, undefined);
      const current = await this.repo.findMedia(tx, productId, mediaId);
      if (current === null) throw new NotFoundError('Media');
      if (changes.isPrimary === true && current.kind !== 'IMAGE')
        throw new ValidationError([{ path: 'isPrimary', message: 'Only images can be primary' }]);
      if (changes.isPrimary === true) await this.repo.unsetPrimary(tx, productId, mediaId);
      const row = await this.repo.updateMedia(tx, mediaId, changes);
      await this.repo.touch(tx, productId, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'media.update',
        targetType: 'media',
        targetId: mediaId,
        before: current,
        after: changes,
        reason,
      });
      return row;
    });
    await this.invalidate([], productId);
    return updated;
  }

  async removeMedia(
    productId: string,
    mediaId: string,
    reason: string,
    actor: Actor,
  ): Promise<void> {
    await this.write(async (tx) => {
      const product = await this.lockAndLoad(tx, productId, undefined);
      const current = await this.repo.findMedia(tx, productId, mediaId);
      if (current === null) throw new NotFoundError('Media');
      if (product.status === 'PUBLISHED' && current.isPrimary)
        throw new ConflictError('Set another primary image before removing this one', {
          details: { reason: 'PRIMARY_IMAGE_REQUIRED' },
        });
      await this.repo.softDeleteMedia(tx, mediaId);
      await this.repo.touch(tx, productId, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'media.delete',
        targetType: 'media',
        targetId: mediaId,
        before: current,
        reason,
      });
    });
    await this.invalidate([], productId);
  }

  // ── Safe category/brand delete (plan §E; called by catalog-service, internal) ──

  /**
   * Blocks new assignments to a category/brand iff no live product uses it. The exclusive advisory
   * lock waits for in-flight product writes (which hold the shared lock) and holds back new ones,
   * so the count and the block are atomic with respect to every assignment.
   */
  async blockReference(type: RefType, refId: string): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      await this.repo.lockReferenceExclusive(tx, type, refId);
      const count = await this.repo.countUsing(tx, type, refId);
      if (count > 0)
        throw new ConflictError(
          `${type === 'CATEGORY' ? 'Category' : 'Brand'} is used by ${String(count)} product(s)`,
          {
            details: { reason: 'IN_USE', count },
          },
        );
      await this.repo.block(tx, type, refId);
    });
  }

  unblockReference(type: RefType, refId: string): Promise<void> {
    return this.repo.unblock(type, refId);
  }

  /** Internal: facts of variants for inventory / order / logistics. */
  async variantFacts(ids: readonly string[]): Promise<(VariantFactsV1 & { deleted: boolean })[]> {
    const rows = await this.repo.variantFacts(ids);
    const paths = new Map<string, string[]>();
    for (const categoryId of new Set(rows.map((r) => r.product.categoryId)))
      paths.set(categoryId, await this.categoryPath(categoryId));
    return rows.map((v) => ({
      variantId: v.id,
      productId: v.productId,
      sku: v.sku,
      barcode: v.barcode,
      productName: v.product.name,
      variantName: v.name,
      manufacturerName: v.product.manufacturerName,
      packSize: v.packSize.toString(),
      packUnit: v.packUnit.code,
      isPrescriptionRequired: v.product.isPrescriptionRequired,
      temperatureClass: v.product.temperatureClass,
      shelfLifeMonths: v.product.shelfLifeMonths,
      isActive: v.isActive && v.deletedAt === null,
      categoryId: v.product.categoryId,
      categoryPath: paths.get(v.product.categoryId) ?? [v.product.categoryId],
      brandId: v.product.brandId,
      hsnCode: v.hsnCode,
      gstRate: v.gstRate === null ? null : v.gstRate.toFixed(2),
      // Gross grams of one sellable pack: warehouse capacity in kg (D-56).
      weightGrams: v.weightGrams,
      minOrderQty: v.minOrderQty,
      maxOrderQty: v.maxOrderQty,
      version: v.version,
      deleted: v.deletedAt !== null,
    }));
  }

  // ── Reviews feature (rating projection) ──

  /** Write the denormalised published rating in the review transaction (no version bump). */
  setRating(
    tx: Tx,
    productId: string,
    rating: { ratingAvg: string | null; ratingCount: number },
  ): Promise<void> {
    return this.repo.setRating(tx, productId, rating);
  }

  /** Live product facts for reviews; `reviewable` = published and active (shown on the store). */
  async reviewTarget(
    ref: { id: string } | { slug: string },
  ): Promise<{ id: string; name: string; slug: string; reviewable: boolean } | null> {
    const p = await this.repo.reviewTarget(ref);
    if (p === null) return null;
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      reviewable: p.status === 'PUBLISHED' && p.isActive,
    };
  }

  /** id → { name, slug } for admin review lists. */
  async productNames(ids: readonly string[]): Promise<Map<string, { name: string; slug: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.repo.productNames([...new Set(ids)]);
    return new Map(rows.map((r) => [r.id, { name: r.name, slug: r.slug }]));
  }

  // ── Helpers ──

  /** One transaction; unique-index races still map to a clean 409. */
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.deps.runInTransaction(work);
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate(uniqueViolationFields(error));
      const mapped = mapPrismaError(error);
      throw mapped instanceof Error ? mapped : error;
    }
  }

  private async lockAndLoad(
    tx: Tx,
    id: string,
    ifMatch: number | undefined,
  ): Promise<ProductRecord> {
    if (!(await this.repo.lockProduct(tx, id))) throw new NotFoundError('Product');
    const record = await this.loadOrThrow(tx, id);
    if (ifMatch !== undefined && ifMatch !== record.version) throw versionConflict(record.version);
    return record;
  }

  private async loadOrThrow(tx: Tx, id: string): Promise<ProductRecord> {
    const record = await this.repo.findDetail(id, tx);
    if (record === null) throw new NotFoundError('Product');
    return record;
  }

  private variantOf(product: ProductRecord, variantId: string): VariantRecord {
    const variant = product.variants.find((v) => v.id === variantId);
    if (variant === undefined) throw new NotFoundError('Variant');
    return variant;
  }

  /** Shared reference locks + no reference block (safe-delete protocol). */
  private async assertReferencesOpen(tx: Tx, categoryId?: string, brandId?: string): Promise<void> {
    const issues = [];
    if (categoryId !== undefined) {
      await this.repo.lockReferenceShared(tx, 'CATEGORY', categoryId);
      if (await this.repo.isBlocked(tx, 'CATEGORY', categoryId))
        issues.push({ path: 'categoryId', message: 'Category is being deleted' });
    }
    if (brandId !== undefined) {
      await this.repo.lockReferenceShared(tx, 'BRAND', brandId);
      if (await this.repo.isBlocked(tx, 'BRAND', brandId))
        issues.push({ path: 'brandId', message: 'Brand is being deleted' });
    }
    if (issues.length > 0) throw new ValidationError(issues);
  }

  private async assertAttributes(
    pathIds: readonly string[],
    values: Record<string, unknown>,
    enforceRequired: boolean,
  ): Promise<void> {
    const defs = await this.deps.attributesService.effectiveFor(pathIds);
    const issues = validateAttributeValues(defs, values, { enforceRequired });
    if (issues.length > 0) throw new ValidationError(issues);
  }

  private async resolveLookups(
    tx: Tx,
    refs: {
      dosageFormId?: string | null;
      routeIds?: string[];
      speciesIds?: string[];
      productionStages?: string[];
      ingredients?: { unitId: string; perUnitId?: string | null }[];
      variants: { packUnitId?: string }[];
    },
  ): Promise<Map<string, LookupRow>> {
    if (refs.productionStages !== undefined && refs.productionStages.length > 0)
      await this.deps.lookupsService.resolveCodes(
        tx,
        'FLOCK_STAGE',
        refs.productionStages,
        'productionStages',
      );
    const list: [string, string, LookupGroup][] = [];
    if (refs.dosageFormId !== undefined && refs.dosageFormId !== null)
      list.push(['dosageFormId', refs.dosageFormId, 'DOSAGE_FORM']);
    refs.routeIds?.forEach((id, i) => list.push([`routeIds[${String(i)}]`, id, 'ROUTE']));
    refs.speciesIds?.forEach((id, i) => list.push([`speciesIds[${String(i)}]`, id, 'SPECIES']));
    refs.ingredients?.forEach((ing, i) => {
      list.push([`ingredients[${String(i)}].unitId`, ing.unitId, 'UNIT']);
      if (ing.perUnitId !== undefined && ing.perUnitId !== null)
        list.push([`ingredients[${String(i)}].perUnitId`, ing.perUnitId, 'UNIT']);
    });
    refs.variants.forEach((v, i) => {
      if (v.packUnitId !== undefined)
        list.push([`variants[${String(i)}].packUnitId`, v.packUnitId, 'UNIT']);
    });
    return this.deps.lookupsService.resolve(tx, { refs: list });
  }

  private assertUniqueWithin(variants: readonly VariantInput[]): void {
    const seen = new Set<string>();
    const barcodes = new Set<string>();
    variants.forEach((v, i) => {
      if (seen.has(v.sku))
        throw new ValidationError([
          { path: `variants[${String(i)}].sku`, message: 'Duplicate SKU in request' },
        ]);
      seen.add(v.sku);
      if (v.barcode !== undefined && v.barcode !== null) {
        if (barcodes.has(v.barcode))
          throw new ValidationError([
            { path: `variants[${String(i)}].barcode`, message: 'Duplicate barcode in request' },
          ]);
        barcodes.add(v.barcode);
      }
    });
  }

  private async assertVariantKeysFree(
    tx: Tx,
    variants: readonly { sku?: string; barcode?: string | null }[],
    excludeVariantId?: string,
  ): Promise<void> {
    const skus = variants.flatMap((v) => (v.sku === undefined ? [] : [v.sku]));
    const barcodes = variants.flatMap((v) =>
      v.barcode === undefined || v.barcode === null ? [] : [v.barcode],
    );
    const taken = await this.repo.variantKeyConflicts(tx, skus, barcodes, excludeVariantId);
    const fields = [
      ...(taken.skus.length > 0 ? ['sku'] : []),
      ...(taken.barcodes.length > 0 ? ['barcode'] : []),
    ];
    if (fields.length > 0) throw duplicate(fields);
  }

  private async chooseSlug(tx: Tx, name: string, wanted: string | undefined): Promise<string> {
    if (wanted !== undefined) {
      if (await this.repo.slugTaken(tx, wanted)) throw duplicate(['slug']);
      return wanted;
    }
    const base = slugify(name);
    return firstFreeSlug(base, await this.repo.slugsStartingWith(tx, base));
  }

  /** Scalar columns from the input (only keys present; '' → null for optional text). */
  private scalarData(fields: Partial<ProductFields>): Partial<ProductData> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields) as [string, unknown][]) {
      if (value === undefined || RELATION_KEYS.has(key)) continue;
      out[key] = value === '' ? null : value;
    }
    return out;
  }

  private async refreshPriceSummary(tx: Tx, productId: string): Promise<void> {
    const variants = await this.repo.pricedVariants(tx, productId);
    await this.repo.setPriceSummary(
      tx,
      productId,
      priceSummary(
        variants.map((v) => ({
          mrp: v.mrp.toString(),
          sellingPrice: v.price === null ? null : v.price.sellingPrice.toString(),
        })),
      ),
    );
  }

  /** Builds the compliance subject from a product record and runs the matrix. */
  private async evaluate(
    record: ProductRecord,
    tx?: Tx,
    enforceAttributes = true,
  ): Promise<ComplianceIssue[]> {
    const ctx = await this.deps.catalogClient.categoryContext(record.categoryId);
    const pathIds = ctx?.pathIds ?? [record.categoryId];
    const [profile, defs] = await Promise.all([
      this.deps.attributesService.complianceFor(pathIds, tx),
      this.deps.attributesService.effectiveFor(pathIds, tx),
    ]);
    const subject: ComplianceSubject = {
      drugSchedule: record.drugSchedule,
      registrationAuthority: record.registrationAuthority,
      registrationNo: record.registrationNo,
      drugLicenseNo: record.drugLicenseNo,
      manufacturingLicenseNo: record.manufacturingLicenseNo,
      isPrescriptionRequired: record.isPrescriptionRequired,
      isVetConsultRequired: record.isVetConsultRequired,
      isAntimicrobial: record.isAntimicrobial,
      genericName: record.genericName,
      manufacturerName: record.manufacturerName,
      ingredientCount: record.ingredients.length,
      species: record.species.map(({ lookup }) => {
        const meta = lookup.meta as SpeciesMeta;
        return {
          producesMeat: meta.producesMeat === true,
          producesEggs: meta.producesEggs === true,
        };
      }),
      withdrawalMeatDays: record.withdrawalMeatDays,
      withdrawalEggDays: record.withdrawalEggDays,
      temperatureClass: record.temperatureClass,
      storageMinTempC:
        record.storageMinTempC === null ? null : Number(record.storageMinTempC.toString()),
      storageMaxTempC:
        record.storageMaxTempC === null ? null : Number(record.storageMaxTempC.toString()),
      storageInstructions: record.storageInstructions,
      hazardClass: record.hazardClass,
      unNumber: record.unNumber,
      docTypes: record.media.flatMap((m) => (m.docType === null ? [] : [m.docType])),
      hasPrimaryImage: record.media.some(
        (m) => m.kind === 'IMAGE' && m.isPrimary && m.variantId === null,
      ),
      hasActiveDefaultVariant: record.variants.some((v) => v.isDefault && v.isActive),
    };
    const issues = checkCompliance(subject, profile);
    if (enforceAttributes) {
      for (const issue of validateAttributeValues(
        defs,
        record.attributes as Record<string, unknown>,
      ))
        issues.push({ rule: 'ATTR', ...issue });
    }
    return issues;
  }

  /** Category ids root → self (Redis snapshot first); just the category itself if unknown. */
  private async categoryPath(categoryId: string): Promise<string[]> {
    const ctx = await this.deps.catalogClient.categoryContext(categoryId);
    return ctx?.pathIds ?? [categoryId];
  }

  private facts(product: ProductRecord, v: VariantRecord, categoryPath: string[]): VariantFactsV1 {
    return {
      variantId: v.id,
      productId: product.id,
      sku: v.sku,
      barcode: v.barcode,
      productName: product.name,
      variantName: v.name,
      manufacturerName: product.manufacturerName,
      packSize: v.packSize.toString(),
      packUnit: v.packUnit.code,
      isPrescriptionRequired: product.isPrescriptionRequired,
      temperatureClass: product.temperatureClass,
      shelfLifeMonths: product.shelfLifeMonths,
      isActive: v.isActive,
      categoryId: product.categoryId,
      categoryPath,
      brandId: product.brandId,
      hsnCode: v.hsnCode,
      gstRate: v.gstRate === null ? null : v.gstRate.toFixed(2),
      weightGrams: v.weightGrams,
      minOrderQty: v.minOrderQty,
      maxOrderQty: v.maxOrderQty,
      version: v.version,
      // D-57: warehouse (WMS) projection fields (additive).
      brandName: product.brandName,
      primaryImageUrl:
        product.media.find(
          (m) => m.kind === 'IMAGE' && (m.variantId === null || m.variantId === v.id),
        )?.url ?? null,
      drugSchedule: product.drugSchedule,
      isAntimicrobial: product.isAntimicrobial,
      isVetConsultRequired: product.isVetConsultRequired,
      hazardClass: product.hazardClass ?? null,
    };
  }

  private async afterWrite(id: string, extraSlugs: string[] = []): Promise<ProductView> {
    const view = await this.detail(id);
    await this.invalidate([view.slug, ...extraSlugs]);
    return view;
  }

  /** Bump the list version (all list pages expire) and drop detail keys. Best effort. */
  async invalidate(slugs: string[], productId?: string): Promise<void> {
    try {
      const redis = this.deps.redis;
      const keys = new Set(slugs.filter((s) => s !== ''));
      if (productId !== undefined) {
        const record = await this.repo.findDetail(productId);
        if (record !== null) keys.add(record.slug);
      }
      await redis.incr(productKeys.listVersion());
      if (keys.size > 0) await redis.del(...[...keys].map((slug) => productKeys.product(slug)));
    } catch (err) {
      this.deps.logger.warn({ err }, 'product cache invalidation failed');
    }
  }
}
