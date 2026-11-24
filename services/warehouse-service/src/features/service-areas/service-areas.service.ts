import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { WAREHOUSE_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { emitWarehouseEvent } from '../../adapters/events.js';
import type { Caller } from '../../middleware/guards.js';
import type { Actor } from '../audit/index.js';
import { STATES, type SetupFacts, type WarehouseRecord, stateName } from '../warehouses/index.js';
import { MAX_PINS_PER_WAREHOUSE, compressPins, expandPins } from './service-areas.pins.js';
import {
  type AreaDetail,
  type AreaPriority,
  type AreaRecord,
  type AreaView,
  type CoverageCandidate,
  type CreateAreaInput,
  PRIORITY_RANK,
  type ReassignInput,
  type ServiceAreasView,
  type UpdateAreaInput,
} from './service-areas.types.js';

const STATE_CODES = new Set(STATES.map((s) => s.code));

const actorOf = (caller: Caller): Actor => ({
  userId: caller.userId,
  ip: caller.ip,
  requestId: caller.requestId,
});

/** Expanded PINs, or 422 listing every bad entry under `field`. */
const parsePins = (entries: readonly string[], field: string): string[] => {
  const { pins, issues } = expandPins(entries);
  if (issues.length > 0)
    throw new ValidationError(
      issues.map((i) => ({ path: field, message: `"${i.entry}": ${i.message}` })),
    );
  return pins;
};

const assertState = (stateCode: string): void => {
  if (!STATE_CODES.has(stateCode))
    throw new ValidationError([{ path: 'body.stateCode', message: 'unknown GST state code' }]);
};

const toView = (a: AreaRecord, bounds?: { min: string; max: string }): AreaView => ({
  id: a.id,
  kind: a.kind,
  stateCode: a.stateCode,
  stateName: stateName(a.stateCode),
  district: a.district,
  priority: a.priority,
  pinCount: a.pinCount,
  firstPin: bounds?.min ?? null,
  lastPin: bounds?.max ?? null,
  updatedAt: a.updatedAt.toISOString(),
});

/**
 * Service areas (W2.04, wizard step 2, D-56): districts and PINs per warehouse, by priority.
 * Every write locks the warehouse row, checks `coverageVersion`, changes the PINs, bumps the
 * version, audits and emits the COMPLETE coverage (`warehouse.coverage_replaced.v1`) in one
 * transaction; inventory-service applies it to its allocation copy.
 */
export class ServiceAreasService {
  private readonly repo: Cradle['serviceAreasRepository'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly auditService: Cradle['auditService'];
  private readonly warehouses: Pick<Cradle, 'warehousesService'>;

  constructor(
    deps: Pick<
      Cradle,
      'serviceAreasRepository' | 'runInTransaction' | 'auditService' | 'warehousesService'
    >,
  ) {
    this.repo = deps.serviceAreasRepository;
    this.runInTransaction = deps.runInTransaction;
    this.auditService = deps.auditService;
    this.warehouses = deps;
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────

  async list(caller: Caller, warehouseId: string): Promise<ServiceAreasView> {
    const w = await this.warehouses.warehousesService.requireVisible(
      caller,
      warehouseId,
      'warehouse.view',
    );
    const { areas, bounds } = await this.repo.list(warehouseId);
    const byPriority = new Map<AreaPriority, number>();
    let districts = 0;
    let pinCodes = 0;
    let unassignedPins = 0;
    for (const a of areas) {
      pinCodes += a.pinCount;
      if (a.kind === 'IMPORTED') unassignedPins += a.pinCount;
      else if (a.priority !== null) {
        districts += 1;
        byPriority.set(a.priority, (byPriority.get(a.priority) ?? 0) + a.pinCount);
      }
    }
    const defaultPriority =
      [...byPriority].sort(
        (x, y) => y[1] - x[1] || PRIORITY_RANK[x[0]] - PRIORITY_RANK[y[0]],
      )[0]?.[0] ?? null;
    return {
      warehouseId,
      coverageVersion: w.coverageVersion,
      summary: { districts, pinCodes, unassignedPins, defaultPriority },
      areas: areas.map((a) => toView(a, bounds.get(a.id))),
    };
  }

  async get(caller: Caller, warehouseId: string, areaId: string): Promise<AreaDetail> {
    await this.warehouses.warehousesService.requireVisible(caller, warehouseId, 'warehouse.view');
    const area = await this.repo.find(warehouseId, areaId);
    if (area === null) throw new NotFoundError('Service area');
    const pins = await this.repo.pins(areaId);
    return {
      ...toView(area, pins.length > 0 ? { min: pins[0] ?? '', max: pins.at(-1) ?? '' } : undefined),
      pins,
      ranges: compressPins(pins),
    };
  }

  /** Who serves a PIN, in allocation order (only warehouses the caller may see). */
  /**
   * D-57b W3.12 routing: every non-draft warehouse serving a PIN (network-wide, no caller scope;
   * routing is a GLOBAL configuration evaluated for every order).
   */
  async networkCoverage(pinCode: string): Promise<CoverageCandidate[]> {
    const rows = await this.repo.candidates(pinCode);
    const byId = new Map(
      (await this.warehouses.warehousesService.findMany(rows.map((r) => r.warehouseId))).map(
        (w) => [w.id, w] as const,
      ),
    );
    return rows.flatMap((r) => {
      const w = byId.get(r.warehouseId);
      if (w === undefined || w.status === 'SETUP') return [];
      return [
        {
          warehouseId: w.id,
          code: w.code,
          name: w.name,
          type: w.type,
          status: w.status,
          priorityRank: r.priorityRank,
          warehousePriority: w.priority,
          routable: w.status === 'ACTIVE' && w.isAllocatable,
        },
      ];
    });
  }

  async coverage(caller: Caller, pinCode: string): Promise<CoverageCandidate[]> {
    const rows = await this.repo.candidates(pinCode);
    const scope = caller.access.scope('warehouse.view');
    const visible = rows.filter((r) => scope === 'ALL' || scope.includes(r.warehouseId));
    const byId = new Map(
      (await this.warehouses.warehousesService.findMany(visible.map((r) => r.warehouseId))).map(
        (w) => [w.id, w] as const,
      ),
    );
    return visible
      .map((r) => ({ r, w: byId.get(r.warehouseId) }))
      .filter((x): x is { r: (typeof visible)[number]; w: WarehouseRecord } => x.w !== undefined)
      .filter((x) => scope === 'ALL' || x.w.status !== 'SETUP')
      .map(({ r, w }) => ({
        warehouseId: w.id,
        code: w.code,
        name: w.name,
        type: w.type,
        status: w.status,
        priorityRank: r.priorityRank,
        warehousePriority: w.priority,
        routable: w.status === 'ACTIVE' && w.isAllocatable,
      }))
      .sort(
        (a, b) =>
          a.priorityRank - b.priorityRank ||
          a.warehousePriority - b.warehousePriority ||
          a.code.localeCompare(b.code),
      );
  }

  /** District suggestions for a state: names already used by areas and warehouse addresses. */
  async districts(stateCode: string): Promise<string[]> {
    const [fromAreas, fromWarehouses] = await Promise.all([
      this.repo.districts(stateCode),
      this.warehouses.warehousesService.districtsIn(stateCode),
    ]);
    const seen = new Map<string, string>();
    for (const d of [...fromAreas, ...fromWarehouses]) seen.set(d.toLowerCase(), d);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  /** Setup checklist facts per warehouse (warehouses feature). */
  async setupFacts(
    warehouseIds: readonly string[],
    tx?: Tx,
  ): Promise<Map<string, Pick<SetupFacts, 'districtAreas' | 'unassignedPins'>>> {
    const facts = new Map<string, Pick<SetupFacts, 'districtAreas' | 'unassignedPins'>>();
    for (const row of await this.repo.counts(warehouseIds, tx)) {
      const f = facts.get(row.warehouseId) ?? { districtAreas: 0, unassignedPins: 0 };
      if (row.kind === 'IMPORTED') f.unassignedPins += row.pins;
      else f.districtAreas += row.pins > 0 ? 1 : 0;
      facts.set(row.warehouseId, f);
    }
    return facts;
  }

  // ── Writes ───────────────────────────────────────────────────────────────────────────────

  /** Assign a district with PINs / ranges (W2.04 "Add area"). */
  async create(
    caller: Caller,
    warehouseId: string,
    input: CreateAreaInput,
  ): Promise<ServiceAreasView> {
    assertState(input.stateCode);
    const pins = parsePins(input.pins, 'body.pins');
    if (pins.length === 0)
      throw new ValidationError([{ path: 'body.pins', message: 'add at least one PIN' }]);
    await this.write(caller, warehouseId, input.expectedVersion, async (tx) => {
      if ((await this.repo.findDistrict(tx, warehouseId, input.stateCode, input.district)) !== null)
        throw new ConflictError('This district is already assigned; edit it to add PINs', {
          details: { reason: 'DISTRICT_EXISTS' },
        });
      await this.assertFree(tx, warehouseId, pins, null);
      const area = await this.repo.createArea(tx, {
        warehouseId,
        kind: 'DISTRICT',
        stateCode: input.stateCode,
        district: input.district,
        priority: input.priority,
        userId: caller.userId,
      });
      await this.repo.addPins(tx, warehouseId, area.id, pins, PRIORITY_RANK[input.priority]);
      return {
        action: 'service_area.create',
        targetId: area.id,
        after: {
          stateCode: input.stateCode,
          district: input.district,
          priority: input.priority,
          pins: pins.length,
        },
      };
    });
    return this.list(caller, warehouseId);
  }

  /** Edit priority / district, add or remove PINs. */
  async update(
    caller: Caller,
    warehouseId: string,
    areaId: string,
    input: UpdateAreaInput,
  ): Promise<ServiceAreasView> {
    if (input.stateCode !== undefined) assertState(input.stateCode);
    const add = parsePins(input.addPins ?? [], 'body.addPins');
    const remove = parsePins(input.removePins ?? [], 'body.removePins');
    await this.write(caller, warehouseId, input.expectedVersion, async (tx) => {
      const area = await this.repo.find(warehouseId, areaId, tx);
      if (area === null) throw new NotFoundError('Service area');
      const edits =
        input.priority !== undefined ||
        input.district !== undefined ||
        input.stateCode !== undefined ||
        add.length > 0;
      if (area.kind === 'IMPORTED' && edits)
        throw new BadRequestError(
          'Imported PINs have no district yet: move them to a district instead (reassign)',
        );
      const stateCode = input.stateCode ?? area.stateCode ?? '';
      const district = input.district ?? area.district ?? '';
      if (input.stateCode !== undefined || input.district !== undefined) {
        const clash = await this.repo.findDistrict(tx, warehouseId, stateCode, district);
        if (clash !== null && clash.id !== areaId)
          throw new ConflictError('This district is already assigned', {
            details: { reason: 'DISTRICT_EXISTS' },
          });
      }
      const priority = input.priority ?? area.priority;
      await this.repo.updateArea(tx, areaId, {
        ...(input.stateCode === undefined ? {} : { stateCode: input.stateCode }),
        ...(input.district === undefined ? {} : { district: input.district }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        userId: caller.userId,
      });
      if (input.priority !== undefined && priority !== null)
        await this.repo.setRank(tx, areaId, PRIORITY_RANK[priority]);
      if (remove.length > 0) {
        const owned = (await this.repo.existing(tx, warehouseId, remove)).filter(
          (p) => p.areaId === areaId,
        );
        await this.repo.removePins(
          tx,
          warehouseId,
          owned.map((p) => p.pinCode),
        );
      }
      if (add.length > 0 && priority !== null) {
        await this.assertFree(tx, warehouseId, add, areaId);
        const already = new Set(
          (await this.repo.existing(tx, warehouseId, add)).map((p) => p.pinCode),
        );
        await this.repo.addPins(
          tx,
          warehouseId,
          areaId,
          add.filter((p) => !already.has(p)),
          PRIORITY_RANK[priority],
        );
      }
      return {
        action: 'service_area.update',
        targetId: areaId,
        before: { district: area.district, priority: area.priority, pins: area.pinCount },
        after: { district, priority, added: add.length, removed: remove.length },
      };
    });
    return this.list(caller, warehouseId);
  }

  /** Delete one or more areas (their PINs stop being served by this warehouse). */
  async remove(
    caller: Caller,
    warehouseId: string,
    areaIds: readonly string[],
    expectedVersion: number,
  ): Promise<ServiceAreasView> {
    await this.write(caller, warehouseId, expectedVersion, async (tx) => {
      const areas = await this.repo.findMany(warehouseId, areaIds, tx);
      if (areas.length !== new Set(areaIds).size) throw new NotFoundError('Service area');
      await this.repo.deleteAreas(tx, warehouseId, areaIds);
      return {
        action: 'service_area.delete',
        targetId: areaIds.join(',').slice(0, 64),
        before: {
          areas: areas.map((a) => ({ district: a.district, kind: a.kind, pins: a.pinCount })),
        },
      };
    });
    return this.list(caller, warehouseId);
  }

  /**
   * Move imported PINs (no district yet) into a district area. The ONLY way an imported PIN's
   * routing rank changes: an explicit, audited admin action.
   */
  async reassign(
    caller: Caller,
    warehouseId: string,
    areaId: string,
    input: ReassignInput,
  ): Promise<ServiceAreasView> {
    assertState(input.stateCode);
    const pins = input.all === true ? 'ALL' : parsePins(input.pins ?? [], 'body.pins');
    if (pins !== 'ALL' && pins.length === 0)
      throw new ValidationError([{ path: 'body.pins', message: 'choose PINs or all' }]);
    await this.write(caller, warehouseId, input.expectedVersion, async (tx) => {
      const from = await this.repo.find(warehouseId, areaId, tx);
      if (from === null) throw new NotFoundError('Service area');
      if (from.kind !== 'IMPORTED')
        throw new BadRequestError(
          'Only imported PINs are reassigned; edit district areas directly',
        );
      if (pins !== 'ALL') {
        const foreign = (await this.repo.existing(tx, warehouseId, pins)).filter(
          (p) => p.areaId !== areaId,
        );
        const known = new Set(
          (await this.repo.existing(tx, warehouseId, pins)).map((p) => p.pinCode),
        );
        const unknown = pins.filter((p) => !known.has(p));
        if (foreign.length > 0 || unknown.length > 0)
          throw new ValidationError([
            {
              path: 'body.pins',
              message: `not in the imported list: ${[...foreign.map((p) => p.pinCode), ...unknown].slice(0, 20).join(', ')}`,
            },
          ]);
      }
      const target =
        (await this.repo.findDistrict(tx, warehouseId, input.stateCode, input.district)) ??
        (await this.repo.createArea(tx, {
          warehouseId,
          kind: 'DISTRICT',
          stateCode: input.stateCode,
          district: input.district,
          priority: input.priority,
          userId: caller.userId,
        }));
      const rank = PRIORITY_RANK[target.priority ?? input.priority];
      const moved = await this.repo.movePins(tx, warehouseId, areaId, pins, target.id, rank);
      return {
        action: 'service_area.reassign',
        targetId: target.id,
        after: { district: input.district, stateCode: input.stateCode, moved, rank },
      };
    });
    return this.list(caller, warehouseId);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────

  /** 409 when PINs already belong to ANOTHER area of this warehouse (one area per PIN). */
  private async assertFree(
    tx: Tx,
    warehouseId: string,
    pins: readonly string[],
    ownAreaId: string | null,
  ): Promise<void> {
    const taken = (await this.repo.existing(tx, warehouseId, pins)).filter(
      (p) => p.areaId !== ownAreaId,
    );
    if (taken.length > 0)
      throw new ConflictError('Some PINs are already in another area of this warehouse', {
        details: { reason: 'PIN_TAKEN', pins: taken.slice(0, 50).map((p) => p.pinCode) },
      });
  }

  /** The shared write path: lock, version check, change, recount, cap, bump, audit, event. */
  private async write(
    caller: Caller,
    warehouseId: string,
    expectedVersion: number,
    change: (
      tx: Tx,
    ) => Promise<{ action: string; targetId: string; before?: object; after?: object }>,
  ): Promise<void> {
    const { warehousesService } = this.warehouses;
    await warehousesService.requireVisible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx) => {
      await warehousesService.lockForCoverage(tx, warehouseId, expectedVersion);
      const audit = await change(tx);
      const total = await this.repo.refreshCounts(tx, warehouseId);
      if (total > MAX_PINS_PER_WAREHOUSE)
        throw new ValidationError([
          {
            path: 'body',
            message: `a warehouse may serve at most ${MAX_PINS_PER_WAREHOUSE} PINs (would be ${total})`,
          },
        ]);
      const coverageVersion = await warehousesService.bumpCoverageVersion(
        tx,
        warehouseId,
        caller.userId,
      );
      await this.auditService.record(tx, actorOf(caller), {
        action: audit.action,
        targetType: 'service_area',
        targetId: audit.targetId,
        before: audit.before ?? null,
        after: { ...audit.after, warehouseId, coverageVersion },
      });
      await emitWarehouseEvent(
        tx,
        WAREHOUSE_EVENTS.coverageReplaced,
        { warehouseId, coverageVersion, entries: await this.repo.entries(tx, warehouseId) },
        caller.requestId,
      );
    });
  }
}
