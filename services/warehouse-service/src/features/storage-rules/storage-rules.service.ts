import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import type { Actor } from '../audit/index.js';
import { MAX_RULES, type RuleRow } from './storage-rules.repository.js';
import { type RuleType, type ZoneFacts, ruleWarnings } from './storage-rules.rules.js';
import type { RuleInput, RuleUpdate, RuleView, RulesSummary } from './storage-rules.types.js';

const FEET_TO_METRES = 0.3048;
const actorOf = (c: Caller): Actor => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });

const toMetres = (value: number | null | undefined, unit: 'METRES' | 'FEET' | undefined) =>
  value === undefined || value === null
    ? value
    : Math.round((unit === 'FEET' ? value * FEET_TO_METRES : value) * 100) / 100;

/** Type-specific requirements (422 otherwise). */
const assertShape = (r: {
  type: RuleType;
  keepAwayCategoryIds: readonly string[];
  allowedZoneId: string | null;
}): void => {
  if ((r.type === 'SEGREGATION' || r.type === 'INCOMPATIBLE') && r.keepAwayCategoryIds.length === 0)
    throw new ValidationError([
      { path: 'body.keepAwayCategoryIds', message: 'say what to keep it away from' },
    ]);
  if ((r.type === 'FOOD_GRADE_ZONE' || r.type === 'HAZARD_CLASS') && r.allowedZoneId === null)
    throw new ValidationError([{ path: 'body.allowedZoneId', message: 'choose the zone to use' }]);
};

/**
 * Storage compatibility rules (W2.08, D-56). Saved and checked for consistency (zone setup,
 * catalog), never enforced until put-away (W8): every response says `NOT_ENFORCED`.
 */
export class StorageRulesService {
  private readonly repo: Cradle['storageRulesRepository'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly auditService: Cradle['auditService'];
  private readonly catalogClient: Cradle['catalogClient'];
  private readonly lazy: Pick<Cradle, 'warehousesService' | 'storageService'>;

  constructor(
    deps: Pick<
      Cradle,
      | 'storageRulesRepository'
      | 'runInTransaction'
      | 'auditService'
      | 'catalogClient'
      | 'warehousesService'
      | 'storageService'
    >,
  ) {
    this.repo = deps.storageRulesRepository;
    this.runInTransaction = deps.runInTransaction;
    this.auditService = deps.auditService;
    this.catalogClient = deps.catalogClient;
    this.lazy = deps;
  }

  async list(caller: Caller, warehouseId: string, type?: RuleType): Promise<RuleView[]> {
    await this.visible(caller, warehouseId, 'warehouse.view');
    const [rows, ctx] = await Promise.all([
      this.repo.list(warehouseId, type),
      this.context(warehouseId),
    ]);
    return rows.map((r) => this.view(r, ctx));
  }

  async summary(caller: Caller, warehouseId: string): Promise<RulesSummary> {
    await this.visible(caller, warehouseId, 'warehouse.view');
    const [rows, ctx] = await Promise.all([this.repo.list(warehouseId), this.context(warehouseId)]);
    const active = rows.filter((r) => r.status === 'ACTIVE');
    const restricted = new Set(
      active
        .filter((r) => r.type === 'HAZARD_CLASS' || r.type === 'SEGREGATION')
        .flatMap((r) => r.subjectCategoryIds),
    );
    return {
      activeRules: active.length,
      foodGradeZones: ctx.zones.filter((z) => z.status === 'ACTIVE' && z.isFoodGrade).length,
      restrictedItems: restricted.size,
      itemsNeedingReview: active.filter((r) => this.view(r, ctx).warnings.length > 0).length,
      enforcement: 'NOT_ENFORCED',
      modules: { putaway: false },
    };
  }

  async create(caller: Caller, warehouseId: string, input: RuleInput): Promise<RuleView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    const keepAway = [...new Set(input.keepAwayCategoryIds ?? [])];
    assertShape({
      type: input.type,
      keepAwayCategoryIds: keepAway,
      allowedZoneId: input.allowedZoneId ?? null,
    });
    const row = await this.runInTransaction(async (tx) => {
      if ((await this.repo.count(tx, warehouseId)) >= MAX_RULES)
        throw new ConflictError(`At most ${String(MAX_RULES)} rules per warehouse`, {
          details: { reason: 'LIMIT_REACHED' },
        });
      await this.assertZone(warehouseId, input.allowedZoneId ?? null);
      const r = await this.repo.create(tx, {
        warehouseId,
        type: input.type,
        name: input.name,
        subjectCategoryIds: [...new Set(input.subjectCategoryIds)],
        keepAwayCategoryIds: keepAway,
        allowedZoneId: input.allowedZoneId ?? null,
        minDistanceM: toMetres(input.minDistance, input.minDistanceUnit) ?? null,
        notes: input.notes ?? null,
        status: input.status ?? 'ACTIVE',
        createdByUserId: caller.userId,
        updatedByUserId: caller.userId,
      });
      await this.auditService.record(tx, actorOf(caller), {
        action: 'storage_rule.create',
        targetType: 'storage_rule',
        targetId: r.id,
        after: r,
      });
      return r;
    });
    return this.view(row, await this.context(warehouseId));
  }

  async update(
    caller: Caller,
    warehouseId: string,
    ruleId: string,
    input: RuleUpdate,
  ): Promise<RuleView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    const { expectedVersion, minDistance, minDistanceUnit, ...changes } = input;
    const row = await this.runInTransaction(async (tx) => {
      const before = await this.repo.lock(tx, warehouseId, ruleId);
      if (before === null) throw new NotFoundError('Storage rule');
      if (before.version !== expectedVersion)
        throw new ConflictError('Changed by someone else; reload and retry', {
          details: { reason: 'VERSION_CONFLICT', currentVersion: before.version },
        });
      const merged = {
        type: before.type,
        keepAwayCategoryIds: changes.keepAwayCategoryIds ?? before.keepAwayCategoryIds,
        allowedZoneId:
          changes.allowedZoneId === undefined ? before.allowedZoneId : changes.allowedZoneId,
      };
      assertShape(merged);
      if (changes.allowedZoneId !== undefined)
        await this.assertZone(warehouseId, changes.allowedZoneId);
      const after = await this.repo.update(tx, ruleId, {
        ...changes,
        ...(changes.subjectCategoryIds === undefined
          ? {}
          : { subjectCategoryIds: [...new Set(changes.subjectCategoryIds)] }),
        ...(changes.keepAwayCategoryIds === undefined
          ? {}
          : { keepAwayCategoryIds: [...new Set(changes.keepAwayCategoryIds)] }),
        ...(minDistance === undefined
          ? {}
          : { minDistanceM: toMetres(minDistance, minDistanceUnit) }),
        updatedByUserId: caller.userId,
      });
      await this.auditService.record(tx, actorOf(caller), {
        action: 'storage_rule.update',
        targetType: 'storage_rule',
        targetId: ruleId,
        before,
        after,
      });
      return after;
    });
    return this.view(row, await this.context(warehouseId));
  }

  async remove(caller: Caller, warehouseId: string, ruleId: string): Promise<void> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx: Tx) => {
      const before = await this.repo.lock(tx, warehouseId, ruleId);
      if (before === null) throw new NotFoundError('Storage rule');
      await this.repo.delete(tx, ruleId);
      await this.auditService.record(tx, actorOf(caller), {
        action: 'storage_rule.delete',
        targetType: 'storage_rule',
        targetId: ruleId,
        before,
      });
    });
  }

  // ── Helpers ──

  private async context(warehouseId: string) {
    const [zones, categories] = await Promise.all([
      this.lazy.storageService.zoneIndex(warehouseId),
      this.catalogClient.categories(),
    ]);
    return { zones, categories };
  }

  private view(
    r: RuleRow,
    ctx: {
      zones: (ZoneFacts & { name: string })[];
      categories: Map<string, string> | null;
    },
  ): RuleView {
    const names = (ids: readonly string[]) =>
      ids.map((id) => ({ id, name: ctx.categories?.get(id) ?? null }));
    const zone = ctx.zones.find((z) => z.id === r.allowedZoneId);
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      subjectCategories: names(r.subjectCategoryIds),
      keepAwayCategories: names(r.keepAwayCategoryIds),
      allowedZone: zone === undefined ? null : { id: zone.id, code: zone.code, name: zone.name },
      minDistanceM: r.minDistanceM === null ? null : num(r.minDistanceM).toFixed(2),
      notes: r.notes,
      status: r.status,
      version: r.version,
      enforcement: 'NOT_ENFORCED',
      warnings: ruleWarnings(
        {
          type: r.type,
          subjectCategoryIds: r.subjectCategoryIds,
          keepAwayCategoryIds: r.keepAwayCategoryIds,
          allowedZoneId: r.allowedZoneId,
          minDistanceM: r.minDistanceM === null ? null : num(r.minDistanceM),
        },
        ctx.zones,
        ctx.categories === null ? null : new Set(ctx.categories.keys()),
      ),
    };
  }

  private async assertZone(warehouseId: string, zoneId: string | null): Promise<void> {
    if (zoneId === null) return;
    const zones = await this.lazy.storageService.zoneIndex(warehouseId);
    if (!zones.some((z) => z.id === zoneId))
      throw new ValidationError([{ path: 'body.allowedZoneId', message: 'unknown zone' }]);
  }

  private visible(caller: Caller, warehouseId: string, key: string) {
    return this.lazy.warehousesService.requireVisible(caller, warehouseId, key);
  }
}
