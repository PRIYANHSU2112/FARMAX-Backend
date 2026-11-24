import { AppError, ConflictError, ErrorCode, NotFoundError } from '@farmx/common/errors';
import { type Tx, advisoryXactLock } from '@farmx/database';
import { type RoutingRulesReplacedV1, WAREHOUSE_EVENTS } from '@farmx/infra/events';
import {
  type FallbackStrategy,
  type RankBy,
  type RoutingCondition,
  type RoutingDecision,
  type RoutingFallbackV1,
  type RoutingGates,
  type RoutingNode,
  type RoutingOrder,
  type RoutingRuleV1,
  conditionLabel,
  distanceKm,
  evaluateRouting,
} from '@farmx/infra/routing';
import type { Cradle } from '@fastify/awilix';

import { emitWarehouseEvent } from '../../adapters/events.js';
import type { Caller } from '../../middleware/guards.js';
import { type Paging, csvCell, decodeCursor, toPageResult } from '../../middleware/paging.js';
import { slaDueAt } from '../fulfilment/index.js';
import type { JsonInput, RuleRow } from './routing.repository.js';
import { EQUIPMENT, MAX_RULES, RANK_BY, STRATEGIES, TEMP_CLASSES } from './routing.validation.js';

const actorOf = (c: Caller) => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });
const LOCK = 'wms:routing';
/** Live priorities move out of the way of the unique index before a renumber. */
const DRAFT_PRIORITY = 0;
const num = (d: { toString(): string } | null | undefined) =>
  d === null || d === undefined ? null : Number(d.toString());
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

type Status = 'ACTIVE' | 'INACTIVE' | 'DRAFT';
const statusOf = (r: RuleRow): Status =>
  r.isDraft ? 'DRAFT' : r.isEnabled ? 'ACTIVE' : 'INACTIVE';

const toV1 = (r: RuleRow): RoutingRuleV1 => ({
  id: r.id,
  name: r.name,
  priority: r.priority,
  conditions: r.conditions as unknown as RoutingCondition[],
  primaryWarehouseId: r.primaryWarehouseId,
  fallbackWarehouseIds: r.fallbackWarehouseIds,
  rankBy: r.rankBy,
  gates: r.gates as unknown as RoutingGates,
  isEnabled: r.isEnabled,
});

/** Snapshot of a rule for the version history (append-only). */
const snap = (r: RuleRow) => ({
  name: r.name,
  tag: r.tag,
  priority: r.isDraft ? null : r.priority,
  status: statusOf(r),
  conditions: r.conditions,
  primaryWarehouseId: r.primaryWarehouseId,
  primaryDockDoorId: r.primaryDockDoorId,
  fallbackWarehouseIds: r.fallbackWarehouseIds,
  rankBy: r.rankBy,
  gates: r.gates,
});

export interface RuleInput {
  name?: string;
  tag?: string | null;
  conditions?: RoutingCondition[];
  primaryWarehouseId?: string | null;
  primaryDockDoorId?: string | null;
  fallbackWarehouseIds?: string[];
  rankBy?: RankBy;
  gates?: RoutingGates;
  isEnabled?: boolean;
  isDraft?: boolean;
  priority?: number;
  reason?: string | null;
}

export interface SimOrderInput {
  orderId?: string;
  pinCode?: string;
  stateCode?: string | null;
  district?: string | null;
  orderValue?: number | null;
  weightKg?: number | null;
  categoryIds?: string[];
  coldRequired?: boolean;
  temperatureClasses?: string[];
  hazardous?: boolean;
  lat?: number | null;
  lng?: number | null;
  lines?: { variantId: string; qty: number }[];
}

export interface SimOptions {
  includeDrafts?: boolean;
  ruleIds?: string[];
}

export interface FallbackInput {
  strategy: FallbackStrategy;
  nodeIds: string[];
  centralWarehouseId: string | null;
  allowPartial: boolean;
  maxDistanceKm: number | null;
  reason?: string | null;
}

interface Line {
  variantId: string;
  qty: number;
}

const STRATEGY_TEXT: Record<FallbackStrategy, string> = {
  NEXT_NEAREST: 'Next nearest node that serves the PIN and passes the checks.',
  ALTERNATE_REGIONAL_HUB: 'Nearest mother (regional) hub first, then the nearest depots.',
  NODE_LIST: 'The listed nodes in order, then the nearest others.',
  CENTRAL: 'The central warehouse first, then the nearest others.',
  HOLD_ORDER: 'None: the order is held and an allocation issue is raised (quarantine order).',
};

const CONDITION_CATALOG = [
  { type: 'PIN_RANGE', label: 'PIN code range', fields: ['from', 'to'] },
  { type: 'PIN_LIST', label: 'PIN code list', fields: ['pins[]'] },
  { type: 'STATE', label: 'State (GST code)', fields: ['codes[]'] },
  { type: 'DISTRICT', label: 'District', fields: ['names[]'] },
  { type: 'CATEGORY', label: 'Product category', fields: ['ids[]', 'match (any | all)'] },
  { type: 'ORDER_VALUE', label: 'Order value (₹)', fields: ['op (lt | gte)', 'amount'] },
  { type: 'ORDER_WEIGHT_KG', label: 'Order weight (kg)', fields: ['op (lt | gte)', 'kg'] },
  { type: 'COLD_REQUIRED', label: 'Needs cold chain', fields: ['value'] },
  { type: 'TEMPERATURE_CLASS', label: 'Temperature class', fields: ['classes[]'] },
  { type: 'HAZARDOUS', label: 'Hazardous goods', fields: ['value'] },
] as const;

const GATE_CATALOG = [
  { key: 'maxDistanceKm', label: 'Max distance (km)', kind: 'number' },
  { key: 'stockFull', label: 'Node holds every line in full', kind: 'boolean' },
  { key: 'dispatchWithinHours', label: 'Can dispatch within (hours)', kind: 'number' },
  { key: 'dockEquipment', label: 'Dock capability', kind: 'enum[]', values: EQUIPMENT },
] as const;

const RANK_TEXT: Record<RankBy, string> = {
  NEAREST: 'Nearest to the delivery point',
  PRIORITY: 'Primary, then fallbacks in the listed order',
  MOST_STOCK: 'Most units of the order in stock',
  LOWEST_COST: 'Lowest freight cost',
};

/**
 * Routing rules engine (D-57b W3.12). Rules live here; every change publishes ONE versioned
 * snapshot (`warehouse.routing_rules_replaced.v1`) that inventory applies at checkout. The same
 * pure evaluator (`@farmx/infra/routing`) runs the simulation and the W3.04 candidates with real
 * node facts: PIN coverage, stock, throttles + daily caps, cold chain, dock equipment, calendar.
 */
export class RoutingService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'routingRepository'
      | 'runInTransaction'
      | 'auditService'
      | 'stockSettings'
      | 'stockService'
      | 'fulfilmentSettings'
      | 'fulfilmentQueries'
      | 'fulfilmentOrders'
      | 'serviceAreasService'
      | 'warehousesService'
      | 'docksService'
      | 'calendarService'
      | 'authClient'
    >,
  ) {}

  private get repo() {
    return this.deps.routingRepository;
  }

  // ── Header + node load ──

  async summary(f: { from?: Date; to?: Date }) {
    const to = f.to ?? new Date();
    const from = f.from ?? new Date(to.getTime() - 30 * 86_400_000);
    const [rules, stats, load, published] = await Promise.all([
      this.repo.rules(),
      this.deps.fulfilmentQueries.routedStats(from, to),
      this.nodeLoad(),
      this.published(),
    ]);
    const count = (s: Status) => rules.filter((r) => statusOf(r) === s).length;
    return {
      total: rules.length,
      active: count('ACTIVE'),
      inactive: count('INACTIVE'),
      draft: count('DRAFT'),
      maxRules: MAX_RULES,
      period: { from, to },
      orders: stats.orders,
      routed: stats.auto,
      routedPct: pct(stats.auto, stats.orders),
      loadStatus: load.loadStatus,
      published,
      asOf: new Date(),
    };
  }

  /** Node load factor: today's released orders against the daily cap, open floor work, pause. */
  async nodeLoad() {
    const [whs, throttles, counts, bands] = await Promise.all([
      this.deps.warehousesService.visible('ALL'),
      this.repo.throttles(),
      this.deps.fulfilmentQueries.nodeCounts(),
      this.loadBands(),
    ]);
    const nodes = whs
      .filter((w) => w.status !== 'SETUP')
      .map((w) => {
        const t = throttles.find((x) => x.warehouseId === w.id);
        const c = counts.get(w.id);
        const released = c?.releasedToday ?? 0;
        const cap = t?.maxOrdersPerDay ?? null;
        const loadPct = cap === null ? null : pct(released, cap);
        const band =
          loadPct === null
            ? null
            : loadPct >= bands.saturated
              ? 'SATURATED'
              : loadPct >= bands.strained
                ? 'STRAINED'
                : 'BALANCED';
        return {
          warehouseId: w.id,
          code: w.code,
          name: w.name,
          type: w.type,
          status: w.status,
          routable: w.status === 'ACTIVE' && w.isAllocatable,
          paused: t?.paused === true,
          maxOrdersPerDay: cap,
          capReached: cap !== null && released >= cap,
          note: t?.note ?? null,
          throttleVersion: t?.version ?? null,
          openShipments: c?.open ?? 0,
          releasedToday: released,
          dispatchedToday: c?.dispatchedToday ?? 0,
          loadPct,
          band,
        };
      });
    const worst = nodes.some((n) => n.band === 'SATURATED')
      ? 'SATURATED'
      : nodes.some((n) => n.band === 'STRAINED')
        ? 'STRAINED'
        : 'BALANCED';
    return { loadStatus: worst, bands, nodes, asOf: new Date() };
  }

  async putThrottle(
    caller: Caller,
    warehouseId: string,
    input: {
      paused: boolean;
      maxOrdersPerDay: number | null;
      note?: string | null;
      expectedVersion?: number;
    },
  ) {
    const [w] = await this.deps.warehousesService.findMany([warehouseId]);
    if (w === undefined) throw new NotFoundError('Warehouse');
    await this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, LOCK);
      const before = (await this.repo.throttles(tx)).find((t) => t.warehouseId === warehouseId);
      if (input.expectedVersion !== undefined && (before?.version ?? 0) !== input.expectedVersion)
        throw versionConflict();
      const after = await this.repo.upsertThrottle(tx, warehouseId, {
        paused: input.paused,
        maxOrdersPerDay: input.maxOrdersPerDay,
        note: input.note === '' ? null : (input.note ?? null),
        updatedBy: caller.userId,
      });
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'routing.throttle',
        targetType: 'routing_throttle',
        targetId: warehouseId,
        before:
          before === undefined
            ? null
            : { paused: before.paused, maxOrdersPerDay: before.maxOrdersPerDay },
        after: { paused: after.paused, maxOrdersPerDay: after.maxOrdersPerDay, note: after.note },
      });
      await this.publish(tx, caller.requestId, caller.userId);
    });
    return (await this.nodeLoad()).nodes.find((n) => n.warehouseId === warehouseId) ?? null;
  }

  /**
   * Cap watch (job, every 5 min): when a node's daily cap is reached (or a new day frees it),
   * republish the snapshot so checkout skips / uses it again.
   */
  async capWatch() {
    const [throttles, counts, cur] = await Promise.all([
      this.repo.throttles(),
      this.deps.fulfilmentQueries.nodeCounts(),
      this.deps.stockSettings.raw(['routing.capReached']),
    ]);
    const reached = throttles
      .filter(
        (t) =>
          t.maxOrdersPerDay !== null &&
          (counts.get(t.warehouseId)?.releasedToday ?? 0) >= t.maxOrdersPerDay,
      )
      .map((t) => t.warehouseId)
      .sort();
    const prev = (cur.get('routing.capReached') as string[] | undefined) ?? [];
    if (JSON.stringify(prev) === JSON.stringify(reached)) return { republished: false, reached };
    await this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, LOCK);
      await this.publish(tx, `cap-watch:${new Date().toISOString()}`, null, reached);
    });
    return { republished: true, reached };
  }

  // ── Rules ──

  async rules(f: {
    q?: string;
    status?: Status;
    tag?: string;
    priorityFrom?: number;
    priorityTo?: number;
  }) {
    const rows = (await this.repo.rules()).filter(
      (r) =>
        (f.status === undefined || statusOf(r) === f.status) &&
        (f.tag === undefined || r.tag === f.tag) &&
        (f.priorityFrom === undefined || (!r.isDraft && r.priority >= f.priorityFrom)) &&
        (f.priorityTo === undefined || (!r.isDraft && r.priority <= f.priorityTo)) &&
        (f.q === undefined || r.name.toLowerCase().includes(f.q.toLowerCase())),
    );
    return this.views(rows);
  }

  async rule(id: string) {
    const r = await this.repo.rule(id);
    if (r === null) throw new NotFoundError('Routing rule');
    const [v] = await this.views([r]);
    return v;
  }

  async create(caller: Caller, input: RuleInput) {
    const draft = input.isDraft === true;
    await this.check(input, draft);
    const id = await this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, LOCK);
      const rows = await this.repo.rules(tx);
      if (rows.length >= MAX_RULES)
        throw new ConflictError(`At most ${String(MAX_RULES)} routing rules`, {
          details: { reason: 'RULE_LIMIT', max: MAX_RULES },
        });
      const created = await this.repo.createRule(tx, {
        name: input.name ?? '',
        tag: input.tag ?? null,
        priority: draft ? DRAFT_PRIORITY : 900_000,
        conditions: input.conditions ?? [],
        primaryWarehouseId: input.primaryWarehouseId ?? null,
        primaryDockDoorId: input.primaryDockDoorId ?? null,
        fallbackWarehouseIds: dedupe(input),
        rankBy: input.rankBy ?? 'NEAREST',
        gates: (input.gates ?? {}) as JsonInput,
        isEnabled: draft ? false : (input.isEnabled ?? true),
        isDraft: draft,
        createdBy: caller.userId,
        updatedBy: caller.userId,
      });
      if (!draft) await this.place(tx, rows, created.id, input.priority);
      await this.recordChange(tx, caller, created.id, 'CREATE', null, input.reason ?? null);
      if (!draft) await this.publish(tx, caller.requestId, caller.userId);
      return created.id;
    });
    return this.rule(id);
  }

  async patch(caller: Caller, id: string, input: RuleInput & { expectedVersion: number }) {
    const { expectedVersion, reason, priority, ...fields } = input;
    await this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, LOCK);
      const rows = await this.repo.rules(tx);
      const cur = rows.find((r) => r.id === id);
      if (cur === undefined) throw new NotFoundError('Routing rule');
      if (cur.version !== expectedVersion) throw versionConflict();
      const draft = fields.isDraft ?? cur.isDraft;
      const merged: RuleInput = {
        name: fields.name ?? cur.name,
        conditions: fields.conditions ?? (cur.conditions as unknown as RoutingCondition[]),
        primaryWarehouseId:
          fields.primaryWarehouseId === undefined
            ? cur.primaryWarehouseId
            : fields.primaryWarehouseId,
        primaryDockDoorId:
          fields.primaryDockDoorId === undefined ? cur.primaryDockDoorId : fields.primaryDockDoorId,
        fallbackWarehouseIds: fields.fallbackWarehouseIds ?? cur.fallbackWarehouseIds,
        rankBy: fields.rankBy ?? cur.rankBy,
        gates: fields.gates ?? (cur.gates as unknown as RoutingGates),
      };
      await this.check(merged, draft);
      const goingLive = cur.isDraft && !draft;
      const goingDraft = !cur.isDraft && draft;
      await this.repo.updateRule(tx, id, {
        ...(fields.name === undefined ? {} : { name: fields.name }),
        ...(fields.tag === undefined ? {} : { tag: fields.tag }),
        ...(fields.conditions === undefined
          ? {}
          : { conditions: fields.conditions }),
        primaryWarehouseId: merged.primaryWarehouseId ?? null,
        primaryDockDoorId: merged.primaryDockDoorId ?? null,
        fallbackWarehouseIds: dedupe(merged),
        ...(fields.rankBy === undefined ? {} : { rankBy: fields.rankBy }),
        ...(fields.gates === undefined ? {} : { gates: fields.gates as JsonInput }),
        isDraft: draft,
        isEnabled: draft ? false : (fields.isEnabled ?? (goingLive ? true : cur.isEnabled)),
        ...(goingLive ? { priority: 900_000 } : {}),
        ...(goingDraft ? { priority: DRAFT_PRIORITY } : {}),
        updatedBy: caller.userId,
      });
      const live = rows.filter((r) => !r.isDraft && r.id !== id);
      if (goingLive || (!draft && priority !== undefined && priority !== cur.priority))
        await this.place(tx, live, id, priority ?? (goingLive ? undefined : cur.priority));
      else if (goingDraft)
        await this.renumber(
          tx,
          live.map((r) => r.id),
        );
      const action = goingLive ? 'PUBLISH' : goingDraft ? 'UNPUBLISH' : 'UPDATE';
      await this.recordChange(tx, caller, id, action, cur, reason ?? null);
      if (!(cur.isDraft && draft)) await this.publish(tx, caller.requestId, caller.userId);
    });
    return this.rule(id);
  }

  async setEnabled(
    caller: Caller,
    id: string,
    enabled: boolean,
    input: { expectedVersion: number; reason?: string | null },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, LOCK);
      const cur = await this.repo.rule(id, tx);
      if (cur === null) throw new NotFoundError('Routing rule');
      if (cur.version !== input.expectedVersion) throw versionConflict();
      if (cur.isDraft)
        throw new ConflictError('Publish the draft first', { details: { reason: 'DRAFT' } });
      if (cur.isEnabled === enabled) return;
      await this.repo.updateRule(tx, id, { isEnabled: enabled, updatedBy: caller.userId });
      await this.recordChange(
        tx,
        caller,
        id,
        enabled ? 'ENABLE' : 'DISABLE',
        cur,
        input.reason ?? null,
      );
      await this.publish(tx, caller.requestId, caller.userId);
    });
    return this.rule(id);
  }

  /** Soft delete; the live rules below move up one place. */
  async remove(caller: Caller, id: string, input: { expectedVersion: number; reason: string }) {
    await this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, LOCK);
      const rows = await this.repo.rules(tx);
      const cur = rows.find((r) => r.id === id);
      if (cur === undefined) throw new NotFoundError('Routing rule');
      if (cur.version !== input.expectedVersion) throw versionConflict();
      await this.repo.updateRule(tx, id, {
        deletedAt: new Date(),
        isEnabled: false,
        ...(cur.isDraft ? {} : { priority: -1 }),
        updatedBy: caller.userId,
      });
      if (!cur.isDraft)
        await this.renumber(
          tx,
          rows.filter((r) => !r.isDraft && r.id !== id).map((r) => r.id),
        );
      await this.repo.addVersion(tx, {
        ruleId: id,
        version: cur.version + 1,
        action: 'DELETE',
        snapshot: snap(cur),
        by: caller.userId,
      });
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'routing.rule_delete',
        targetType: 'routing_rule',
        targetId: id,
        before: snap(cur),
        reason: input.reason,
      });
      if (!cur.isDraft) await this.publish(tx, caller.requestId, caller.userId);
    });
  }

  /** Drag reorder: the full list of live rule ids, first = priority 1. */
  async reorder(caller: Caller, input: { ruleIds: string[]; reason?: string | null }) {
    await this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, LOCK);
      const live = (await this.repo.rules(tx)).filter((r) => !r.isDraft);
      const ids = new Set(live.map((r) => r.id));
      if (input.ruleIds.length !== ids.size || input.ruleIds.some((x) => !ids.has(x)))
        throw new ConflictError('Send every live rule exactly once', {
          details: { reason: 'ORDER_MISMATCH', liveRules: ids.size },
        });
      const before = live.map((r) => r.id);
      if (before.join() === input.ruleIds.join()) return;
      await this.renumber(tx, input.ruleIds);
      for (const r of live)
        if (input.ruleIds.indexOf(r.id) + 1 !== r.priority)
          await this.recordChange(tx, caller, r.id, 'REORDER', r, input.reason ?? null, false);
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'routing.reorder',
        targetType: 'routing_settings',
        targetId: 'routing',
        before: { order: before },
        after: { order: input.ruleIds },
        reason: input.reason ?? null,
      });
      await this.publish(tx, caller.requestId, caller.userId);
    });
    return this.rules({});
  }

  /** Row ⋮ Duplicate: a disabled draft copy (publish it to make it live). */
  async duplicate(caller: Caller, id: string, input: { name?: string }) {
    const src = await this.repo.rule(id);
    if (src === null) throw new NotFoundError('Routing rule');
    return this.create(caller, {
      name: input.name ?? `${src.name} (copy)`.slice(0, 120),
      tag: src.tag,
      conditions: src.conditions as unknown as RoutingCondition[],
      primaryWarehouseId: src.primaryWarehouseId,
      primaryDockDoorId: src.primaryDockDoorId,
      fallbackWarehouseIds: src.fallbackWarehouseIds,
      rankBy: src.rankBy === 'LOWEST_COST' ? 'NEAREST' : src.rankBy,
      gates: src.gates as unknown as RoutingGates,
      isDraft: true,
      reason: `duplicate of ${src.id}`,
    });
  }

  // ── History / audit / export ──

  async history(ruleId: string | undefined, p: Paging) {
    if (ruleId !== undefined && (await this.repo.ruleAny(ruleId)) === null)
      throw new NotFoundError('Routing rule');
    const before = cursorId(p.cursor);
    const rows = await this.repo.versions(ruleId, before, p.limit);
    const names = await this.people(rows.map((r) => r.by));
    const rules = new Map(
      (await this.repo.rulesAny(rows.map((r) => r.ruleId))).map((r) => [r.id, r.name]),
    );
    const page = toPageResult(rows, p, (r) => [r.id]);
    return {
      ...page,
      items: page.items.map((r) => ({
        id: r.id,
        ruleId: r.ruleId,
        ruleName: rules.get(r.ruleId) ?? null,
        version: r.version,
        action: r.action,
        snapshot: r.snapshot,
        by: r.by === null ? null : (names.get(r.by) ?? { id: r.by, name: null }),
        at: r.at,
      })),
    };
  }

  async audit(p: Paging) {
    const rows = await this.deps.auditService.forTypes(
      ['routing_rule', 'routing_settings', 'routing_throttle'],
      cursorId(p.cursor),
      p.limit,
    );
    const names = await this.people(rows.map((r) => r.actorUserId));
    const page = toPageResult(rows, p, (r) => [r.id]);
    return {
      ...page,
      items: page.items.map((r) => ({
        id: r.id,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        before: r.before,
        after: r.after,
        reason: r.reason,
        actor:
          r.actorUserId === null
            ? null
            : (names.get(r.actorUserId) ?? { id: r.actorUserId, name: null }),
        at: r.createdAt,
      })),
    };
  }

  async *exportCsv(): AsyncGenerator<string> {
    const rows = await this.views(await this.repo.rules());
    yield 'priority,name,tag,status,conditions,primary,dock_door,fallbacks,rank_by,gates,orders_30d,version,updated_at\n';
    for (const r of rows)
      yield `${[
        r.priority,
        r.name,
        r.tag,
        r.status,
        r.conditionsText.join(' AND '),
        r.primaryWarehouse?.code ?? null,
        r.primaryDockDoor?.code ?? null,
        r.fallbackWarehouses.map((w) => w.code).join(' > '),
        r.rankBy,
        JSON.stringify(r.gates),
        r.orders30d,
        r.version,
        r.updatedAt,
      ]
        .map((v) => csvCell(v))
        .join(',')}\n`;
  }

  // ── Catalog ──

  async catalog() {
    const [whs, rules] = await Promise.all([
      this.deps.warehousesService.visible('ALL'),
      this.repo.rules(),
    ]);
    const live = whs.filter((w) => w.status !== 'SETUP');
    const doors = await Promise.all(live.map((w) => this.deps.docksService.doorsFacts(w.id)));
    return {
      conditions: CONDITION_CATALOG,
      gates: GATE_CATALOG,
      rankBy: RANK_BY.map((r) => ({
        value: r,
        label: RANK_TEXT[r],
        available: r !== 'LOWEST_COST',
        reason: r === 'LOWEST_COST' ? 'Needs carrier fare rates (not configured yet)' : null,
      })),
      fallbackStrategies: STRATEGIES.map((s) => ({ value: s, description: STRATEGY_TEXT[s] })),
      temperatureClasses: TEMP_CLASSES,
      dockEquipment: EQUIPMENT,
      tags: [
        ...new Set([
          'STANDARD',
          'PRIORITY',
          'BULK',
          'COLD',
          ...rules.flatMap((r) => (r.tag === null ? [] : [r.tag])),
        ]),
      ],
      warehouses: live.map((w, i) => ({
        id: w.id,
        code: w.code,
        name: w.name,
        type: w.type,
        status: w.status,
        routable: w.status === 'ACTIVE' && w.isAllocatable,
        coldChain: w.temperatureClasses.some((t) => t.startsWith('CC')),
        doors: (doors[i] ?? []).map((d) => ({
          id: d.id,
          code: d.code,
          name: d.name,
          equipment: d.equipment,
        })),
      })),
      optionSources: {
        categories: 'GET /stock/filter-options?field=category',
        districts: 'GET /v1/admin/warehouses/lookups (districts of a state)',
      },
      limits: { maxRules: MAX_RULES, maxConditions: 20, maxFallbacks: 20, matrixCases: 50 },
    };
  }

  // ── Fallback ──

  async fallback() {
    const [f, rules, published] = await Promise.all([
      this.deps.fulfilmentSettings.get('fulfilment.allocationFallback'),
      this.repo.rules(),
      this.published(),
    ]);
    const refs = await this.refs([
      ...f.nodeIds,
      ...(f.centralWarehouseId === null ? [] : [f.centralWarehouseId]),
    ]);
    const active = rules.filter((r) => statusOf(r) === 'ACTIVE').length;
    return {
      ...f,
      nodes: f.nodeIds.map((id) => refs.get(id) ?? { id, code: null, name: null }),
      central: f.centralWarehouseId === null ? null : (refs.get(f.centralWarehouseId) ?? null),
      description: STRATEGY_TEXT[f.strategy],
      mode: 'AUTO',
      modeLabel: 'FEFO Auto',
      pipeline: [
        {
          step: 1,
          key: 'RULES',
          title: 'Match routing rules',
          detail: `${String(active)} active rule(s) are tried by priority; every condition must hold.`,
        },
        {
          step: 2,
          key: 'GATES',
          title: 'Check node gates',
          detail:
            'Serves the PIN, routable, not paused or over its daily cap, cold chain, max distance, full stock, dispatch window, dock capability.',
        },
        {
          step: 3,
          key: 'RANK',
          title: 'Rank eligible nodes',
          detail: "By the rule's rank: nearest, listed priority or most stock.",
        },
        { step: 4, key: 'FALLBACK', title: 'No rule matched', detail: STRATEGY_TEXT[f.strategy] },
        {
          step: 5,
          key: 'PARTIAL',
          title: f.allowPartial ? 'Split across nodes' : 'One node only',
          detail: f.allowPartial
            ? 'A short node ships what it holds; the rest is split, partial-shipped or backordered (W3.14).'
            : 'Only a node holding the whole order is offered.',
        },
        {
          step: 6,
          key: 'FEFO',
          title: 'FEFO lot allocation',
          detail: 'Inside the chosen node, lots are reserved first-expiry-first-out.',
        },
      ],
      published,
    };
  }

  async putFallback(caller: Caller, input: FallbackInput) {
    const ids = [
      ...input.nodeIds,
      ...(input.centralWarehouseId === null ? [] : [input.centralWarehouseId]),
    ];
    await this.requireWarehouses(ids);
    if (input.strategy === 'CENTRAL' && input.centralWarehouseId === null)
      throw invalid('centralWarehouseId', 'is required for the CENTRAL strategy');
    if (input.strategy === 'NODE_LIST' && input.nodeIds.length === 0)
      throw invalid('nodeIds', 'needs at least one node for the NODE_LIST strategy');
    const { reason, ...value } = input;
    await this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, LOCK);
      const before = await this.deps.fulfilmentSettings.get('fulfilment.allocationFallback');
      await this.deps.fulfilmentSettings.set(
        tx,
        'fulfilment.allocationFallback',
        value,
        caller.userId,
      );
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'routing.fallback_update',
        targetType: 'routing_settings',
        targetId: 'fallback',
        before,
        after: value,
        reason: reason ?? null,
      });
      await this.publish(tx, caller.requestId, caller.userId, undefined, value);
    });
    return this.fallback();
  }

  /** Re-sends the current snapshot (e.g. after an inventory restore). */
  async republish(caller: Caller) {
    const version = await this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, LOCK);
      return this.publish(tx, caller.requestId, caller.userId);
    });
    return { version };
  }

  // ── Decisions (simulation + W3.04 candidates) ──

  async simulate(caller: Caller, input: SimOrderInput & SimOptions) {
    const facts = await this.orderFacts(caller, input);
    const { decision, nodes } = await this.decide(facts.order, facts.lines, input);
    return this.explain(facts, decision, nodes);
  }

  async simulateMatrix(
    caller: Caller,
    input: SimOptions & {
      cases: {
        label?: string | null;
        order: SimOrderInput;
        expect?: { warehouseId?: string; ruleId?: string | null };
      }[];
    },
  ) {
    const out = [];
    for (const [i, c] of input.cases.entries()) {
      const facts = await this.orderFacts(caller, c.order);
      const { decision } = await this.decide(facts.order, facts.lines, input);
      const winner = decision.hold ? null : (decision.ordered[0] ?? null);
      const pass =
        c.expect === undefined
          ? null
          : (c.expect.warehouseId === undefined || c.expect.warehouseId === winner) &&
            (c.expect.ruleId === undefined || c.expect.ruleId === decision.ruleId);
      out.push({
        index: i,
        label: c.label ?? null,
        pinCode: facts.order.pinCode,
        ruleId: decision.ruleId,
        ruleName: decision.ruleName,
        fallbackUsed: decision.fallbackUsed,
        hold: decision.hold,
        winnerId: winner,
        expect: c.expect ?? null,
        pass,
      });
    }
    const refs = await this.refs(out.flatMap((r) => (r.winnerId === null ? [] : [r.winnerId])));
    const rows = out.map(({ winnerId, ...r }) => ({
      ...r,
      winner: winnerId === null ? null : (refs.get(winnerId) ?? { id: winnerId }),
    }));
    return {
      cases: rows,
      totals: {
        cases: rows.length,
        passed: rows.filter((r) => r.pass === true).length,
        failed: rows.filter((r) => r.pass === false).length,
        fallback: rows.filter((r) => r.fallbackUsed).length,
      },
    };
  }

  /**
   * The decision for one order over its PIN's warehouses (used by W3.04 candidates and to stamp
   * `orders.routingRuleId`). Drafts join only for a simulation (`includeDrafts`).
   */
  async decide(order: RoutingOrder, lines: readonly Line[], opts: SimOptions = {}) {
    const [rows, fb, nodes] = await Promise.all([
      this.repo.rules(),
      this.liveFallback(),
      this.nodes(order, lines),
    ]);
    let rules = rows
      .filter((r) => opts.includeDrafts === true || !r.isDraft)
      .map((r, i) =>
        r.isDraft ? { ...toV1(r), priority: MAX_RULES + i, isEnabled: true } : toV1(r),
      );
    if (opts.ruleIds !== undefined) {
      const only = new Set(opts.ruleIds);
      rules = rules.filter((r) => only.has(r.id)).map((r) => ({ ...r, isEnabled: true }));
    }
    const decision = evaluateRouting(
      rules,
      fb,
      order,
      nodes.map((n) => n.node),
    );
    return { decision, nodes };
  }

  /** The rule that decides an order (stamped on `orders.routingRuleId`); null = no live rule. */
  async ruleFor(
    head: Parameters<RoutingService['routingOrder']>[0],
    lines: readonly Line[],
  ): Promise<string | null> {
    const rules = await this.repo.rules();
    if (!rules.some((r) => statusOf(r) === 'ACTIVE')) return null;
    const { decision } = await this.decide(await this.routingOrder(head, lines), lines);
    return decision.ruleId;
  }

  /** Evaluator order from an order's head facts + the product facts of its lines. */
  async routingOrder(
    head: {
      pinCode: string;
      stateCode: string | null;
      district: string | null;
      value: number | null;
      lat: number | null;
      lng: number | null;
    },
    lines: readonly Line[],
  ): Promise<RoutingOrder> {
    const facts =
      lines.length === 0
        ? []
        : await this.deps.stockService.variantRows(lines.map((l) => l.variantId));
    const byId = new Map(facts.map((f) => [f.variantId, f]));
    const kg = lines.reduce(
      (n, l) => n + ((byId.get(l.variantId)?.weightGrams ?? 0) * l.qty) / 1000,
      0,
    );
    const temps = [...new Set(facts.map((f) => f.temperatureClass))];
    return {
      ...head,
      weightKg: lines.length === 0 ? null : Math.round(kg * 10) / 10,
      categoryIds: [
        ...new Set(facts.flatMap((f) => (f.rootCategoryId === null ? [] : [f.rootCategoryId]))),
      ],
      coldRequired: temps.some((t) => t.startsWith('CC')),
      temperatureClasses: temps,
      hazardous: facts.some((f) => f.hazardClass !== null || f.temperatureClass === 'HAZ'),
    };
  }

  // ── internals ──

  private async orderFacts(caller: Caller, o: SimOrderInput) {
    if (o.orderId !== undefined) {
      const { order } = await this.deps.fulfilmentOrders.visible(caller, o.orderId);
      if (order.pinCode === null)
        throw new ConflictError('The order has no delivery PIN yet', {
          details: { reason: 'NO_PIN' },
        });
      const lines = order.lines
        .filter((l) => l.qty - l.cancelledQty > 0)
        .map((l) => ({ variantId: l.variantId, qty: l.qty - l.cancelledQty }));
      return {
        orderId: o.orderId,
        lines,
        order: await this.routingOrder(
          {
            pinCode: order.pinCode,
            stateCode: order.stateCode,
            district: order.district,
            value: num(order.grandTotal),
            lat: num(order.latitude),
            lng: num(order.longitude),
          },
          lines,
        ),
      };
    }
    const lines = o.lines ?? [];
    const base = await this.routingOrder(
      {
        pinCode: o.pinCode ?? '',
        stateCode: o.stateCode ?? null,
        district: o.district ?? null,
        value: o.orderValue ?? null,
        lat: o.lat ?? null,
        lng: o.lng ?? null,
      },
      lines,
    );
    return {
      orderId: null,
      lines,
      order: {
        ...base,
        weightKg: o.weightKg ?? base.weightKg,
        categoryIds: [...new Set([...base.categoryIds, ...(o.categoryIds ?? [])])],
        coldRequired: o.coldRequired ?? base.coldRequired,
        temperatureClasses: [
          ...new Set([...base.temperatureClasses, ...(o.temperatureClasses ?? [])]),
        ],
        hazardous: o.hazardous === true || base.hazardous,
      },
    };
  }

  /** Real node facts of the warehouses serving the PIN. */
  private async nodes(order: RoutingOrder, lines: readonly Line[]) {
    const cover = await this.deps.serviceAreasService.networkCoverage(order.pinCode);
    const ids = cover.map((c) => c.warehouseId);
    const [whs, throttles, counts, ph] = await Promise.all([
      this.deps.warehousesService.findMany(ids),
      this.repo.throttles(),
      this.deps.fulfilmentQueries.nodeCounts(),
      this.deps.fulfilmentSettings.get('fulfilment.priorityDispatchHours'),
    ]);
    const byId = new Map(whs.map((w) => [w.id, w]));
    const now = new Date();
    return Promise.all(
      cover.map(async (c, i) => {
        const w = byId.get(c.warehouseId);
        const [levels, doors, cal] = await Promise.all([
          lines.length === 0
            ? Promise.resolve(new Map<string, { available: number }>())
            : this.deps.stockService.levelsFor(
                c.warehouseId,
                lines.map((l) => l.variantId),
              ),
          this.deps.docksService.doorsFacts(c.warehouseId),
          this.deps.calendarService.slaCalendar(c.warehouseId),
        ]);
        const t = throttles.find((x) => x.warehouseId === c.warehouseId);
        const released = counts.get(c.warehouseId)?.releasedToday ?? 0;
        const capReached = t?.maxOrdersPerDay != null && released >= t.maxOrdersPerDay;
        const due = slaDueAt(now, 'STANDARD', cal, ph);
        const avail = (v: string) => levels.get(v)?.available ?? 0;
        const node: RoutingNode = {
          warehouseId: c.warehouseId,
          type: c.type === 'MOTHER' ? 'MOTHER' : 'DEPOT',
          lat: num(w?.latitude),
          lng: num(w?.longitude),
          priority: i,
          covered: true,
          routable: c.routable,
          throttled: t?.paused === true || capReached,
          coldChain: w?.temperatureClasses.some((x) => x.startsWith('CC')) === true,
          fullStock: lines.every((l) => avail(l.variantId) >= l.qty),
          stockUnits: lines.reduce((n, l) => n + avail(l.variantId), 0),
          equipment: [...new Set(doors.map((d) => d.equipment))],
          dispatchWithinHours: Math.round(((due.getTime() - now.getTime()) / 3_600_000) * 10) / 10,
        };
        return {
          node,
          code: c.code,
          name: c.name,
          paused: t?.paused === true,
          capReached,
          releasedToday: released,
          maxOrdersPerDay: t?.maxOrdersPerDay ?? null,
          lines: lines.map((l) => ({
            variantId: l.variantId,
            need: l.qty,
            available: avail(l.variantId),
          })),
        };
      }),
    );
  }

  private async explain(
    facts: { orderId: string | null; order: RoutingOrder; lines: readonly Line[] },
    decision: RoutingDecision,
    nodes: Awaited<ReturnType<RoutingService['nodes']>>,
  ) {
    const refs = await this.refs([
      ...decision.ordered,
      ...decision.trace.flatMap((s) => s.candidates.map((c) => c.warehouseId)),
    ]);
    const ref = (id: string) => refs.get(id) ?? { id, code: null, name: null };
    const winnerStep = decision.trace.findIndex(
      (s) => s.matched && s.candidates.some((c) => c.passed),
    );
    return {
      orderId: facts.orderId,
      order: facts.order,
      decision: {
        ruleId: decision.ruleId,
        ruleName: decision.ruleName,
        fallbackUsed: decision.fallbackUsed,
        hold: decision.hold,
        winner:
          decision.hold || decision.ordered[0] === undefined ? null : ref(decision.ordered[0]),
        ordered: decision.ordered.map((id, i) => ({ rank: i + 1, ...ref(id) })),
      },
      tree: decision.trace.map((s, i) => ({
        ruleId: s.ruleId,
        ruleName: s.name,
        outcome: !s.matched ? 'NOT_MATCHED' : i === winnerStep ? 'SELECTED' : 'NO_ELIGIBLE_NODE',
        failedConditions: s.failedConditions,
        candidates: s.candidates.map((c) => ({ ...c, ...ref(c.warehouseId), id: undefined })),
      })),
      nodes: nodes.map((n) => ({
        warehouseId: n.node.warehouseId,
        code: n.code,
        name: n.name,
        type: n.node.type,
        distanceKm: distanceKm(facts.order, n.node),
        routable: n.node.routable,
        paused: n.paused,
        capReached: n.capReached,
        releasedToday: n.releasedToday,
        maxOrdersPerDay: n.maxOrdersPerDay,
        coldChain: n.node.coldChain,
        fullStock: n.node.fullStock,
        stockUnits: n.node.stockUnits,
        equipment: n.node.equipment,
        dispatchWithinHours: n.node.dispatchWithinHours,
        lines: n.lines,
      })),
      notes: [
        ...(facts.lines.length === 0 ? ['No lines given: stock gates pass for every node.'] : []),
        ...(facts.order.lat === null
          ? ['No delivery coordinates: distance gates fail and NEAREST keeps the listed order.']
          : []),
      ],
      asOf: new Date(),
    };
  }

  /** Validation that needs data (warehouses, doors) + LOWEST_COST guard. */
  private async check(r: RuleInput, draft: boolean) {
    if (r.rankBy === 'LOWEST_COST')
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Lowest-cost routing is not available', 422, {
        details: {
          reason: 'NOT_AVAILABLE',
          issues: [{ path: 'body.rankBy', message: 'needs carrier fare rates (not configured)' }],
        },
      });
    for (const c of r.conditions ?? [])
      if (c.type === 'PIN_RANGE' && c.from > c.to)
        throw invalid('conditions', 'PIN range "from" must not be after "to"');
    const ids = [
      ...(r.primaryWarehouseId == null ? [] : [r.primaryWarehouseId]),
      ...(r.fallbackWarehouseIds ?? []),
    ];
    if (!draft && ids.length === 0)
      throw invalid('primaryWarehouseId', 'a live rule needs a primary or a fallback warehouse');
    await this.requireWarehouses(ids);
    if (r.primaryDockDoorId != null) {
      if (r.primaryWarehouseId == null)
        throw invalid('primaryDockDoorId', 'needs a primary warehouse');
      const doors = await this.deps.docksService.doorsFacts(r.primaryWarehouseId);
      if (!doors.some((d) => d.id === r.primaryDockDoorId))
        throw invalid('primaryDockDoorId', 'is not a dock door of the primary warehouse');
    }
  }

  private async requireWarehouses(ids: readonly string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    const found = await this.deps.warehousesService.findMany(unique);
    const missing = unique.filter((id) => !found.some((w) => w.id === id && w.status !== 'SETUP'));
    if (missing.length > 0)
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unknown warehouse', 422, {
        details: {
          issues: missing.map((id) => ({ path: 'body', message: `${id} is not a warehouse` })),
        },
      });
  }

  /** Puts `id` at 1-based `position` among `others` (live, without it) and renumbers. */
  private async place(tx: Tx, others: readonly RuleRow[], id: string, position?: number) {
    const order = others.filter((r) => !r.isDraft && r.id !== id).map((r) => r.id);
    const at = position === undefined ? order.length : Math.min(position - 1, order.length);
    order.splice(at, 0, id);
    await this.renumber(tx, order);
  }

  private async renumber(tx: Tx, ids: readonly string[]) {
    await this.repo.renumber(tx, ids);
  }

  private async recordChange(
    tx: Tx,
    caller: Caller,
    id: string,
    action: string,
    before: RuleRow | null,
    reason: string | null,
    audit = true,
  ) {
    const after = await this.repo.rule(id, tx);
    if (after === null) return;
    await this.repo.addVersion(tx, {
      ruleId: id,
      version: after.version,
      action,
      snapshot: snap(after),
      by: caller.userId,
    });
    if (audit)
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: `routing.rule_${action.toLowerCase()}`,
        targetType: 'routing_rule',
        targetId: id,
        before: before === null ? null : snap(before),
        after: snap(after),
        reason,
      });
  }

  /** Builds + emits the versioned snapshot (inventory keeps the highest version). */
  private async publish(
    tx: Tx,
    correlationId: string,
    userId: string | null,
    capReached?: readonly string[],
    fallback?: Omit<FallbackInput, 'reason'>,
  ): Promise<number> {
    const raw = await this.deps.stockSettings.raw([
      'routing.snapshotVersion',
      'routing.capReached',
      'fulfilment.allocationFallback',
    ]);
    const version = Number(raw.get('routing.snapshotVersion') ?? 0) + 1;
    const f =
      fallback ??
      (raw.get('fulfilment.allocationFallback') as FallbackInput | undefined) ??
      (await this.deps.fulfilmentSettings.get('fulfilment.allocationFallback'));
    const reached = new Set(
      capReached ?? (raw.get('routing.capReached') as string[] | undefined) ?? [],
    );
    const [rows, throttles] = await Promise.all([this.repo.rules(tx), this.repo.throttles(tx)]);
    const snapshot: RoutingRulesReplacedV1 = {
      version,
      rules: rows.filter((r) => !r.isDraft).map(toV1),
      fallback: {
        strategy: f.strategy,
        nodeIds: f.nodeIds,
        centralWarehouseId: f.centralWarehouseId,
        maxDistanceKm: f.maxDistanceKm,
      },
      throttles: throttles.map((t) => ({
        warehouseId: t.warehouseId,
        paused: t.paused,
        maxOrdersPerDay: t.maxOrdersPerDay,
        capReached: reached.has(t.warehouseId),
      })),
    };
    await this.deps.stockSettings.setRaw(tx, 'routing.snapshotVersion', version, userId);
    await this.deps.stockSettings.setRaw(
      tx,
      'routing.publishedAt',
      new Date().toISOString(),
      userId,
    );
    if (capReached !== undefined)
      await this.deps.stockSettings.setRaw(tx, 'routing.capReached', [...reached].sort(), userId);
    await emitWarehouseEvent(tx, WAREHOUSE_EVENTS.routingRulesReplaced, snapshot, correlationId);
    return version;
  }

  private async liveFallback(): Promise<RoutingFallbackV1> {
    const f = await this.deps.fulfilmentSettings.get('fulfilment.allocationFallback');
    return {
      strategy: f.strategy,
      nodeIds: f.nodeIds,
      centralWarehouseId: f.centralWarehouseId,
      maxDistanceKm: f.maxDistanceKm,
    };
  }

  private async published() {
    const raw = await this.deps.stockSettings.raw([
      'routing.snapshotVersion',
      'routing.publishedAt',
    ]);
    const v = raw.get('routing.snapshotVersion');
    return {
      version: v === undefined ? null : Number(v),
      publishedAt: (raw.get('routing.publishedAt') as string | undefined) ?? null,
    };
  }

  private async loadBands(): Promise<{ strained: number; saturated: number }> {
    const raw = await this.deps.stockSettings.raw(['routing.loadBands']);
    const v = raw.get('routing.loadBands') as { strained?: number; saturated?: number } | undefined;
    return { strained: v?.strained ?? 70, saturated: v?.saturated ?? 90 };
  }

  private async views(rows: readonly RuleRow[]) {
    const now = new Date();
    const [refs, doors, stats] = await Promise.all([
      this.refs(
        rows.flatMap((r) => [
          ...(r.primaryWarehouseId === null ? [] : [r.primaryWarehouseId]),
          ...r.fallbackWarehouseIds,
        ]),
      ),
      this.deps.docksService.doorCodes(
        rows.flatMap((r) => (r.primaryDockDoorId === null ? [] : [r.primaryDockDoorId])),
      ),
      this.deps.fulfilmentQueries.routedStats(new Date(now.getTime() - 30 * 86_400_000), now),
    ]);
    const hits = new Map(stats.byRule.map((b) => [b.ruleId, b.n]));
    const ref = (id: string) => refs.get(id) ?? { id, code: null, name: null };
    return rows.map((r) => {
      const conditions = r.conditions as unknown as RoutingCondition[];
      return {
        id: r.id,
        name: r.name,
        tag: r.tag,
        priority: r.isDraft ? null : r.priority,
        status: statusOf(r),
        isEnabled: r.isEnabled,
        isDraft: r.isDraft,
        conditions,
        conditionsText: conditions.map(conditionLabel),
        primaryWarehouse: r.primaryWarehouseId === null ? null : ref(r.primaryWarehouseId),
        primaryDockDoor:
          r.primaryDockDoorId === null
            ? null
            : (doors.find((d) => d.id === r.primaryDockDoorId) ?? {
                id: r.primaryDockDoorId,
                code: null,
              }),
        fallbackWarehouses: r.fallbackWarehouseIds.map(ref),
        rankBy: r.rankBy,
        gates: r.gates as unknown as RoutingGates,
        orders30d: hits.get(r.id) ?? 0,
        version: r.version,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        createdBy: r.createdBy,
        updatedBy: r.updatedBy,
      };
    });
  }

  private async refs(ids: readonly string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map<string, { id: string; code: string; name: string }>();
    const rows = await this.deps.warehousesService.findMany(unique);
    return new Map(rows.map((w) => [w.id, { id: w.id, code: w.code, name: w.name }]));
  }

  private async people(ids: readonly (string | null)[]) {
    const found = await this.deps.authClient.contacts(ids.filter((x): x is string => x !== null));
    return new Map([...found].map(([id, c]) => [id, { id, name: c.fullName }]));
  }
}

const versionConflict = () =>
  new ConflictError('The rule changed; reload and retry', {
    details: { reason: 'VERSION_CONFLICT' },
  });

const invalid = (path: string, message: string) =>
  new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid routing rule', 422, {
    details: { issues: [{ path: `body.${path}`, message }] },
  });

const dedupe = (r: RuleInput) =>
  [...new Set(r.fallbackWarehouseIds ?? [])].filter((id) => id !== r.primaryWarehouseId);

const cursorId = (cursor: string | undefined): string | null => {
  const v = decodeCursor(cursor);
  return v === null ? null : String(v[0]);
};

export type { Status as RuleStatus };
