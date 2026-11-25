import { ValidationError } from '@farmx/common/errors';
import type { RunInTransaction, Tx } from '@farmx/database';

import { emitQualityEvent } from '../../adapters/events.js';
import { type Caller, actorOf } from '../../middleware/guards.js';
import { versionConflict } from '../../middleware/http.js';
import type { AuditService } from '../audit/index.js';
import type { LabsService } from '../labs/index.js';
import type { ProjectionsService } from '../projections/index.js';
import type { SpecsRepository } from './specs.repository.js';
import { type SpecParam, specLabel, specProblems } from './specs.rules.js';
import type { SpecInput } from './specs.types.js';

const NOTE = 'Acceptance limits require approved SKU-specific specifications.';

type SpecRow = NonNullable<Awaited<ReturnType<SpecsRepository['load']>>>;
interface VariantFacts {
  variantId: string;
  sku: string;
  name: string;
  variantName: string;
  brandName: string | null;
  packLabel: string | null;
  imageUrl: string | null;
}

export const toParam = (p: SpecRow['params'][number]): SpecParam => ({
  code: p.code,
  name: p.name,
  unit: p.unit,
  rule: p.rule,
  min: p.min,
  max: p.max,
  expectedText: p.expectedText,
  critical: p.critical,
  sortOrder: p.sortOrder,
});

/**
 * W16.09: per-SKU acceptance limits + quality policy. Saving publishes
 * `quality.spec_changed.v1` in the same transaction (warehouse holds new receipts in QC_HOLD).
 */
export class SpecsService {
  constructor(
    private readonly deps: {
      specsRepository: SpecsRepository;
      runInTransaction: RunInTransaction;
      auditService: AuditService;
      projectionsService: ProjectionsService;
      labsService: LabsService;
    },
  ) {}

  /** Spec row of a SKU (active or not), for other features. */
  async policy(variantId: string, tx?: Tx) {
    return this.deps.specsRepository.load(variantId, tx);
  }

  /** Active spec with its parameters (null = none). */
  async activeSpec(variantId: string, tx?: Tx) {
    const spec = await this.deps.specsRepository.load(variantId, tx);
    return spec?.isActive === true ? { ...spec, params: spec.params.map(toParam) } : null;
  }

  async get(variantId: string) {
    const variant = await this.deps.projectionsService.ensureVariant(variantId);
    return this.view(variant, await this.deps.specsRepository.load(variantId));
  }

  async list(q: { q?: string; cursor?: string; limit: number }) {
    const { specsRepository, projectionsService } = this.deps;
    const term = q.q?.trim();
    const ids =
      term === undefined || term === ''
        ? undefined
        : await projectionsService.variantIdsMatching(term);
    const rows = await specsRepository.list(ids, q.cursor, q.limit + 1);
    const page = rows.slice(0, q.limit);
    const variants = await projectionsService.variants(page.map((r) => r.variantId));
    return {
      items: page.map((s) => this.view(variants.get(s.variantId) ?? null, s)),
      nextCursor: rows.length > q.limit ? (page.at(-1)?.variantId ?? null) : null,
      limit: q.limit,
    };
  }

  async put(caller: Caller, variantId: string, input: SpecInput) {
    const { runInTransaction, auditService, projectionsService, labsService, specsRepository } =
      this.deps;
    const variant = await projectionsService.ensureVariant(variantId);
    const params = input.params.map((p, i) => ({
      code: p.code,
      name: p.name,
      unit: p.unit ?? null,
      rule: p.rule,
      min: p.min ?? null,
      max: p.max ?? null,
      expectedText: p.expectedText ?? null,
      critical: p.critical ?? false,
      sortOrder: i,
    }));
    const problems = specProblems(params, input.isActive);
    if (problems.length > 0) throw new ValidationError(problems);
    if (input.defaultLabId !== undefined && input.defaultLabId !== null)
      await labsService.requireActive(input.defaultLabId);

    return runInTransaction(async (tx) => {
      const before = await specsRepository.load(variantId, tx);
      const data = {
        releaseMode: input.releaseMode,
        sampleOnReceipt: input.sampleOnReceipt,
        sampleQty: input.sampleQty,
        sampleUnit: input.sampleUnit,
        defaultLabId: input.defaultLabId ?? null,
        coaValidityDays: input.coaValidityDays ?? null,
        isActive: input.isActive,
        updatedBy: caller.userId,
      };
      if (before === null) {
        if (input.expectedVersion !== 0) throw versionConflict(0);
        await specsRepository.create(tx, { variantId, ...data, version: 1 });
      } else if (
        !(await specsRepository.updateVersioned(tx, variantId, input.expectedVersion, data))
      ) {
        throw versionConflict(before.version);
      }
      await specsRepository.replaceParams(tx, variantId, params);
      const after = await specsRepository.load(variantId, tx);
      if (after === null) throw new Error('spec vanished inside its own transaction');
      await specsRepository.insertHistory(tx, {
        variantId,
        version: after.version,
        snapshot: JSON.parse(JSON.stringify(after)) as object,
        changedBy: caller.userId,
        reason: input.reason,
      });
      await auditService.record(tx, actorOf(caller), {
        action: 'spec.saved',
        targetType: 'spec',
        targetId: variantId,
        before,
        after,
        reason: input.reason,
      });
      await emitQualityEvent(
        tx,
        'quality.spec_changed.v1',
        {
          variantId,
          holdOnReceipt: after.isActive,
          releaseMode: after.releaseMode,
          isActive: after.isActive,
          version: after.version,
        },
        caller.requestId,
      );
      return this.view(variant, after);
    });
  }

  /** Saved versions of a SKU's spec (newest first). */
  async history(variantId: string) {
    const rows = await this.deps.specsRepository.history(variantId);
    return rows.map((r) => ({
      version: r.version,
      changedBy: r.changedBy,
      changedAt: r.changedAt.toISOString(),
      reason: r.reason,
      snapshot: r.snapshot,
    }));
  }

  private view(variant: VariantFacts | null, spec: SpecRow | null) {
    return {
      variantId: variant?.variantId ?? spec?.variantId ?? null,
      product:
        variant === null
          ? null
          : {
              sku: variant.sku,
              name: variant.name,
              variantName: variant.variantName,
              brandName: variant.brandName,
              packLabel: variant.packLabel,
              imageUrl: variant.imageUrl,
            },
      configured: spec !== null,
      releaseMode: spec?.releaseMode ?? 'MANUFACTURER_COA',
      sampleOnReceipt: spec?.sampleOnReceipt ?? true,
      sampleQty: spec?.sampleQty ?? 3,
      sampleUnit: spec?.sampleUnit ?? 'units',
      defaultLabId: spec?.defaultLabId ?? null,
      coaValidityDays: spec?.coaValidityDays ?? null,
      isActive: spec?.isActive ?? false,
      version: spec?.version ?? 0,
      params: (spec?.params ?? []).map((p) => ({ ...toParam(p), specLabel: specLabel(p) })),
      note: NOTE,
      updatedAt: spec?.updatedAt.toISOString() ?? null,
    };
  }
}
