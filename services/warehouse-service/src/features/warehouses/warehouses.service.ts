import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { WAREHOUSE_EVENTS, type WarehouseUpsertedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { StaffContact } from '../../adapters/auth-client.js';
import { emitWarehouseEvent } from '../../adapters/events.js';
import type { WarehouseScope } from '../../middleware/access.js';
import type { Caller } from '../../middleware/guards.js';
import type { Actor } from '../audit/index.js';
import { STATE_CODES, stateName } from './warehouses.lookups.js';
import { type WarehouseUpdate, searchTextOf } from './warehouses.repository.js';
import { needsReason, nextStatus, setupProgress, setupSteps, usedPct } from './warehouses.rules.js';
import type { SetupFacts } from './warehouses.rules.js';
import { num } from '../../middleware/http.js';
import type { StockFigures } from '../stats/index.js';
import {
  type CapacityInput,
  type CreateWarehouseInput,
  type StatusAction,
  type StatusInput,
  type UpdateWarehouseInput,
  type WarehouseListItem,
  type WarehouseListQuery,
  type WarehouseRecord,
  type WarehouseSummary,
  type WarehouseView,
} from './warehouses.types.js';

const EXPORT_MAX_ROWS = 5_000;
const NO_FACTS: SetupFacts = { districtAreas: 0, unassignedPins: 0, activeZones: 0, openDays: 0 };

const actorOf = (caller: Caller): Actor => ({
  userId: caller.userId,
  ip: caller.ip,
  requestId: caller.requestId,
});

const versionConflict = (current: number) =>
  new ConflictError('The warehouse was changed by someone else; reload and retry', {
    details: { reason: 'VERSION_CONFLICT', currentVersion: current },
  });

const toKg = (c: CapacityInput | null | undefined): string | null | undefined => {
  if (c === undefined) return undefined;
  if (c === null) return null;
  return (c.unit === 'TONNES' ? c.value * 1000 : c.value).toFixed(2);
};

/** 10-digit Indian mobile or +91… → E.164. */
const toE164 = (phone: string | null | undefined): string | null | undefined =>
  phone === undefined || phone === null ? phone : phone.startsWith('+') ? phone : `+91${phone}`;

const DUPLICATE_CODE = () =>
  new ConflictError('This warehouse code is already used', {
    details: { reason: 'DUPLICATE_CODE' },
  });
const CENTRAL_EXISTS = () =>
  new ConflictError('There is already a live central warehouse', {
    details: { reason: 'CENTRAL_EXISTS' },
  });

const managerView = (id: string | null, contacts: Map<string, StaffContact>) => {
  if (id === null) return null;
  const c = contacts.get(id);
  return {
    userId: id,
    fullName: c?.fullName ?? null,
    phone: c?.phone ?? null,
    email: c?.email ?? null,
  };
};

/** W2.01 stock columns of one warehouse from its latest snapshot (nulls before the first one). */
const stockColumns = (w: WarehouseRecord, s: StockFigures | undefined) => ({
  stockUnits: s?.onHand ?? null,
  usedKg: s?.usedKg ?? null,
  capacityUsedPct:
    s === undefined
      ? null
      : usedPct(num(s.usedKg), w.capacityKg === null ? null : num(w.capacityKg)),
  weightKnownPct: s?.weightKnownPct ?? null,
});

/** W2.01 KPI totals over the visible warehouses. Capacity use counts only warehouses with a capacity. */
function stockTotals(
  rows: readonly WarehouseRecord[],
  stock: ReadonlyMap<string, StockFigures>,
): Pick<
  WarehouseSummary,
  'totalStockUnits' | 'usedCapacityKg' | 'capacityUsedPct' | 'weightKnownPct' | 'asOf'
> {
  let units = 0;
  let used = 0;
  let usedWithCapacity = 0;
  let capacity = 0;
  let weighted = 0;
  let asOf: string | null = null;
  for (const w of rows) {
    const s = stock.get(w.id);
    if (s === undefined) continue;
    const kg = num(s.usedKg);
    units += s.onHand;
    used += kg;
    weighted += s.weightKnownPct * (s.onHand + s.damaged);
    if (w.capacityKg !== null) {
      capacity += num(w.capacityKg);
      usedWithCapacity += kg;
    }
    if (asOf === null || s.asOf < asOf) asOf = s.asOf;
  }
  const physical = rows.reduce(
    (n, w) => n + (stock.get(w.id)?.onHand ?? 0) + (stock.get(w.id)?.damaged ?? 0),
    0,
  );
  return {
    totalStockUnits: units,
    usedCapacityKg: used.toFixed(2),
    capacityUsedPct: usedPct(usedWithCapacity, capacity > 0 ? capacity : null),
    weightKnownPct: physical === 0 ? null : Math.round((weighted / physical) * 10) / 10,
    asOf,
  };
}

/**
 * The warehouse master (D-56): mother warehouse + C&F depots, the setup wizard and the status
 * state machine. Every change runs under the row lock, bumps `version`, writes an audit row and
 * a `warehouse.upserted.v1` outbox event in ONE transaction (inventory-service applies it).
 */
export class WarehousesService {
  private readonly repo: Cradle['warehousesRepository'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly auditService: Cradle['auditService'];
  private readonly authClient: Cradle['authClient'];
  /** Lazy (awilix proxy): service areas depend on warehouses, resolved at call time. */
  private readonly lazy: Pick<
    Cradle,
    'serviceAreasService' | 'storageService' | 'calendarService' | 'statsService' | 'ordersService'
  >;

  constructor(
    deps: Pick<
      Cradle,
      | 'warehousesRepository'
      | 'runInTransaction'
      | 'auditService'
      | 'authClient'
      | 'serviceAreasService'
      | 'storageService'
      | 'calendarService'
      | 'statsService'
      | 'ordersService'
    >,
  ) {
    this.lazy = deps;
    this.repo = deps.warehousesRepository;
    this.runInTransaction = deps.runInTransaction;
    this.auditService = deps.auditService;
    this.authClient = deps.authClient;
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────

  async list(caller: Caller, query: WarehouseListQuery) {
    const { page, total } = await this.repo.list(query, caller.access.scope('warehouse.view'));
    const ids = page.items.map((w) => w.id);
    const [contacts, facts, stock] = await Promise.all([
      this.authClient.contacts(
        page.items.map((w) => w.managerUserId).filter((id): id is string => id !== null),
      ),
      this.setupFacts(ids),
      this.lazy.statsService.figures(ids),
    ]);
    const items: WarehouseListItem[] = page.items.map((w) => ({
      id: w.id,
      code: w.code,
      name: w.name,
      type: w.type,
      status: w.status,
      city: w.city,
      district: w.district,
      stateCode: w.stateCode,
      stateName: stateName(w.stateCode),
      manager: managerView(w.managerUserId, contacts),
      capacityKg: w.capacityKg,
      isAllocatable: w.isAllocatable,
      reviewPending: w.reviewFields.length > 0,
      setup: setupProgress(setupSteps(w, facts.get(w.id) ?? NO_FACTS)),
      ...stockColumns(w, stock.get(w.id)),
      updatedAt: w.updatedAt.toISOString(),
    }));
    return { items, nextCursor: page.nextCursor, limit: page.limit, total };
  }

  async summary(caller: Caller): Promise<WarehouseSummary> {
    const scope = caller.access.scope('warehouse.view');
    const [{ groups, totalCapacityKg }, visible] = await Promise.all([
      this.repo.summary(scope),
      this.repo.listAll({}, scope, EXPORT_MAX_ROWS),
    ]);
    const stock = await this.lazy.statsService.figures(visible.map((w) => w.id));
    const byType = { MOTHER: 0, DEPOT: 0 };
    const byStatus = { SETUP: 0, ACTIVE: 0, LIMITED: 0, INACTIVE: 0 };
    let total = 0;
    for (const g of groups) {
      byType[g.type] += g.count;
      byStatus[g.status] += g.count;
      total += g.count;
    }
    return { total, byType, byStatus, totalCapacityKg, ...stockTotals(visible, stock) };
  }

  /** The visible warehouses matching the filters, as CSV rows (header first). */
  async exportRows(
    caller: Caller,
    query: Omit<WarehouseListQuery, 'cursor' | 'limit'>,
  ): Promise<string[][]> {
    const rows = await this.repo.listAll(
      query,
      caller.access.scope('warehouse.view'),
      EXPORT_MAX_ROWS,
    );
    const [contacts, stock] = await Promise.all([
      this.authClient.contacts(
        rows.map((w) => w.managerUserId).filter((id): id is string => id !== null),
      ),
      this.lazy.statsService.figures(rows.map((w) => w.id)),
    ]);
    return [
      [
        'Code',
        'Name',
        'Type',
        'Status',
        'City',
        'District',
        'State',
        'PIN',
        'Manager',
        'Phone',
        'Capacity (kg)',
        'Stock units',
        'Used (kg)',
        'Used %',
        'Allocatable',
        'Updated',
      ],
      ...rows.map((w) => [
        w.code,
        w.name,
        w.type,
        w.status,
        w.city,
        w.district ?? '',
        stateName(w.stateCode) ?? w.stateCode,
        w.pinCode,
        managerView(w.managerUserId, contacts)?.fullName ?? '',
        w.phone ?? '',
        w.capacityKg ?? '',
        ...((s) => [
          s.stockUnits === null ? '' : String(s.stockUnits),
          s.usedKg ?? '',
          s.capacityUsedPct === null ? '' : String(s.capacityUsedPct),
        ])(stockColumns(w, stock.get(w.id))),
        w.isAllocatable ? 'yes' : 'no',
        w.updatedAt.toISOString(),
      ]),
    ];
  }

  async codeAvailable(code: string): Promise<{ code: string; available: boolean }> {
    const normalised = code.trim().toUpperCase();
    return { code: normalised, available: !(await this.repo.codeExists(normalised)) };
  }

  async get(caller: Caller, id: string): Promise<WarehouseView> {
    const w = await this.requireVisible(caller, id, 'warehouse.view');
    return this.view(w);
  }

  /** Districts already used in a state (warehouse addresses + service areas) for the dropdown. */
  districtsIn(stateCode: string): Promise<string[]> {
    return this.repo.districts(stateCode);
  }

  /** Header search (portal). */
  search(q: string, scope: WarehouseScope, limit: number): Promise<WarehouseRecord[]> {
    return this.repo.search(q, scope, limit);
  }

  findMany(ids: readonly string[]): Promise<WarehouseRecord[]> {
    return this.repo.findMany(ids);
  }

  /** Every warehouse visible in a scope (portal switcher), at most 500. */
  visible(scope: WarehouseScope): Promise<WarehouseRecord[]> {
    return this.repo.listAll({}, scope, 500);
  }

  // ── Writes ───────────────────────────────────────────────────────────────────────────────

  /** W2.02 step 1: a SETUP draft. Central administration only (GLOBAL `warehouse.create`). */
  async create(caller: Caller, input: CreateWarehouseInput): Promise<WarehouseView> {
    if (!caller.access.isGlobal('warehouse.create')) throw new ForbiddenError();
    this.assertState(input.stateCode);
    if (input.managerUserId != null)
      await this.authClient.requireStaffUser(input.managerUserId, 'body.managerUserId');
    const code = input.code.trim().toUpperCase();
    if (await this.repo.codeExists(code)) throw DUPLICATE_CODE();
    if (input.type === 'MOTHER' && (await this.repo.liveMother()) !== null) throw CENTRAL_EXISTS();
    try {
      const created = await this.runInTransaction(async (tx) => {
        const parentWarehouseId = await this.parentFor(tx, input.type, input.parentWarehouseId);
        const w = await this.repo.create(tx, {
          code,
          name: input.name,
          type: input.type,
          status: 'SETUP',
          parentWarehouseId,
          managerUserId: input.managerUserId ?? null,
          phone: toE164(input.phone) ?? null,
          email: input.email ?? null,
          addressLine: input.addressLine,
          landmark: input.landmark ?? null,
          city: input.city,
          district: input.district,
          stateCode: input.stateCode,
          pinCode: input.pinCode,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          totalAreaSqft: input.totalAreaSqft ?? null,
          capacityKg: toKg(input.capacity) ?? null,
          temperatureClasses: [...new Set(input.temperatureClasses)],
          isAllocatable: input.isAllocatable ?? true,
          priority: input.priority ?? 100,
          searchText: searchTextOf({ code, name: input.name, city: input.city }),
          statusChangedAt: new Date(),
          statusChangedBy: caller.userId,
          createdByUserId: caller.userId,
          updatedByUserId: caller.userId,
        });
        await this.repo.addStatusEvent(tx, {
          warehouseId: w.id,
          fromStatus: null,
          toStatus: 'SETUP',
          reason: null,
          actorUserId: caller.userId,
        });
        await this.auditService.record(tx, actorOf(caller), {
          action: 'warehouse.create',
          targetType: 'warehouse',
          targetId: w.id,
          after: w,
        });
        await this.emitUpserted(tx, w, caller.requestId);
        return w;
      });
      return await this.view(created);
    } catch (error) {
      throw await this.explainConflict(error, code);
    }
  }

  /** Edit details (W2.03 "Edit warehouse", wizard step 1 revisits). Code never changes. */
  async update(caller: Caller, id: string, input: UpdateWarehouseInput): Promise<WarehouseView> {
    caller.access.require('warehouse.configure', id);
    const { expectedVersion, confirm, reason, capacity, phone, ...rest } = input;
    if (rest.stateCode !== undefined) this.assertState(rest.stateCode);
    if (rest.managerUserId != null)
      await this.authClient.requireStaffUser(rest.managerUserId, 'body.managerUserId');
    try {
      const updated = await this.runInTransaction(async (tx) => {
        const before = await this.lockedAt(tx, id, expectedVersion);
        if (rest.type !== undefined && rest.type !== before.type && before.status !== 'SETUP')
          throw new BadRequestError('The type can only change while the warehouse is in setup');
        const type = rest.type ?? before.type;
        const changes: WarehouseUpdate = {
          ...rest,
          ...(rest.temperatureClasses === undefined
            ? {}
            : { temperatureClasses: [...new Set(rest.temperatureClasses)] }),
          ...(capacity === undefined ? {} : { capacityKg: toKg(capacity) }),
          ...(phone === undefined ? {} : { phone: toE164(phone) }),
          ...(rest.type !== undefined || rest.parentWarehouseId !== undefined
            ? { parentWarehouseId: await this.parentFor(tx, type, rest.parentWarehouseId, id) }
            : {}),
        };
        // An imported value is reviewed once it is edited or explicitly confirmed.
        const touched = new Set<string>([
          ...(confirm ?? []),
          ...Object.keys(rest),
          ...(capacity === undefined ? [] : ['capacityKg']),
        ]);
        const reviewFields = before.reviewFields.filter((f) => !touched.has(f));
        if (reviewFields.length !== before.reviewFields.length) changes.reviewFields = reviewFields;
        if (Object.keys(changes).length === 0) return before;
        const name = rest.name ?? before.name;
        const city = rest.city ?? before.city;
        changes.searchText = searchTextOf({ code: before.code, name, city });
        changes.updatedByUserId = caller.userId;
        const after = await this.repo.update(tx, id, changes);
        await this.auditService.record(tx, actorOf(caller), {
          action: 'warehouse.update',
          targetType: 'warehouse',
          targetId: id,
          before: pick(before, Object.keys(changes)),
          after: pick(after, Object.keys(changes)),
          reason: reason ?? null,
        });
        await this.emitUpserted(tx, after, caller.requestId);
        return after;
      });
      return await this.view(updated);
    } catch (error) {
      throw await this.explainConflict(error);
    }
  }

  /**
   * activate (SETUP → ACTIVE), limit (ACTIVE → LIMITED), deactivate (→ INACTIVE), reactivate
   * (→ ACTIVE). Activation needs the setup checklist; a re-activated imported warehouse needs its
   * imported data confirmed. Central administration only (GLOBAL `warehouse.status_change`).
   */
  async changeStatus(
    caller: Caller,
    id: string,
    action: StatusAction,
    input: StatusInput,
  ): Promise<WarehouseView> {
    if (!caller.access.isGlobal('warehouse.status_change')) {
      caller.access.require('warehouse.view', id);
      throw new ForbiddenError();
    }
    if (needsReason(action) && input.reason === undefined)
      throw new ValidationError([{ path: 'body.reason', message: 'is required' }]);
    try {
      const updated = await this.runInTransaction(async (tx) => {
        const before = await this.lockedAt(tx, id, input.expectedVersion);
        const to = nextStatus(before.status, action);
        if (to === null)
          throw new ConflictError(`Cannot ${action} a warehouse that is ${before.status}`, {
            details: { reason: 'INVALID_TRANSITION', status: before.status },
          });
        if (to === 'ACTIVE') await this.assertReady(tx, before);
        if (action === 'deactivate') await this.assertNoOpenOrders(tx, id);
        const now = new Date();
        const after = await this.repo.update(tx, id, {
          status: to,
          statusReason: input.reason ?? null,
          statusChangedAt: now,
          statusChangedBy: caller.userId,
          updatedByUserId: caller.userId,
          ...(action === 'activate' ? { activatedAt: now } : {}),
        });
        await this.repo.addStatusEvent(tx, {
          warehouseId: id,
          fromStatus: before.status,
          toStatus: to,
          reason: input.reason ?? null,
          actorUserId: caller.userId,
        });
        await this.auditService.record(tx, actorOf(caller), {
          action: `warehouse.${action}`,
          targetType: 'warehouse',
          targetId: id,
          before: { status: before.status },
          after: { status: to },
          reason: input.reason ?? null,
        });
        await this.emitUpserted(tx, after, caller.requestId);
        return after;
      });
      return await this.view(updated);
    } catch (error) {
      throw await this.explainConflict(error);
    }
  }

  /** Discard a SETUP draft (soft delete; the code stays taken). */
  async discard(caller: Caller, id: string, expectedVersion: number): Promise<void> {
    if (!caller.access.isGlobal('warehouse.create')) {
      caller.access.require('warehouse.view', id);
      throw new ForbiddenError();
    }
    await this.runInTransaction(async (tx) => {
      const before = await this.lockedAt(tx, id, expectedVersion);
      if (before.status !== 'SETUP')
        throw new ConflictError(
          'Only a warehouse in setup can be discarded; deactivate it instead',
          {
            details: { reason: 'INVALID_TRANSITION', status: before.status },
          },
        );
      const after = await this.repo.update(tx, id, {
        deletedAt: new Date(),
        updatedByUserId: caller.userId,
      });
      await this.auditService.record(tx, actorOf(caller), {
        action: 'warehouse.discard',
        targetType: 'warehouse',
        targetId: id,
        before: { status: before.status },
      });
      await this.emitUpserted(tx, after, caller.requestId, true);
    });
  }

  // ── For other features (through index.ts) ──────────────────────────────────────────────

  /** The warehouse if the caller holds `key` there; 404 when invisible, 403 when not allowed. */
  async requireVisible(caller: Caller, id: string, key: string): Promise<WarehouseRecord> {
    caller.access.require(key, id);
    const w = await this.repo.find(id);
    if (w === null || (w.status === 'SETUP' && !caller.access.isGlobal('warehouse.view')))
      throw new NotFoundError('Warehouse');
    return w;
  }

  /** Coverage writes (service areas): lock the warehouse row and check the coverage version. */
  async lockForCoverage(
    tx: Tx,
    id: string,
    expectedCoverageVersion: number,
  ): Promise<WarehouseRecord> {
    const w = await this.repo.lock(tx, id);
    if (w === null) throw new NotFoundError('Warehouse');
    if (w.coverageVersion !== expectedCoverageVersion)
      throw new ConflictError('The service areas were changed by someone else; reload and retry', {
        details: { reason: 'VERSION_CONFLICT', currentVersion: w.coverageVersion },
      });
    return w;
  }

  bumpCoverageVersion(tx: Tx, id: string, userId: string): Promise<number> {
    return this.repo.bumpCoverageVersion(tx, id, userId);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────

  private async view(w: WarehouseRecord): Promise<WarehouseView> {
    const [contacts, facts, stock] = await Promise.all([
      this.authClient.contacts(w.managerUserId === null ? [] : [w.managerUserId]),
      this.setupFacts([w.id]),
      this.lazy.statsService.figures([w.id]),
    ]);
    const steps = setupSteps(w, facts.get(w.id) ?? NO_FACTS);
    const figures = stock.get(w.id) ?? null;
    return {
      ...w,
      stateName: stateName(w.stateCode),
      manager: managerView(w.managerUserId, contacts),
      statusChangedAt: w.statusChangedAt?.toISOString() ?? null,
      activatedAt: w.activatedAt?.toISOString() ?? null,
      setup: { ...setupProgress(steps), steps },
      stock: figures,
      capacityUsedPct: stockColumns(w, figures ?? undefined).capacityUsedPct,
    };
  }

  /** Checklist facts from the features that own them (one grouped query each). */
  private async setupFacts(ids: readonly string[], tx?: Tx): Promise<Map<string, SetupFacts>> {
    const [areas, zones, days] = await Promise.all([
      this.lazy.serviceAreasService.setupFacts(ids, tx),
      this.lazy.storageService.activeZoneCounts(ids, tx),
      this.lazy.calendarService.openDayCounts(ids, tx),
    ]);
    return new Map(
      ids.map((id) => [
        id,
        {
          districtAreas: areas.get(id)?.districtAreas ?? 0,
          unassignedPins: areas.get(id)?.unassignedPins ?? 0,
          activeZones: zones.get(id) ?? 0,
          openDays: days.get(id) ?? 0,
        },
      ]),
    );
  }

  private async lockedAt(tx: Tx, id: string, expectedVersion: number): Promise<WarehouseRecord> {
    const row = await this.repo.lock(tx, id);
    if (row === null) throw new NotFoundError('Warehouse');
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  /** Deactivation gate: no order still to fulfil here (NEW or ALLOCATED) → else 409. */
  private async assertNoOpenOrders(tx: Tx, id: string): Promise<void> {
    const open = (await this.lazy.ordersService.openCounts([id], tx)).get(id);
    const total = (open?.new ?? 0) + (open?.allocated ?? 0);
    if (total > 0)
      throw new ConflictError(
        `${String(total)} order(s) are still to be fulfilled here; finish or move them first`,
        { details: { reason: 'HAS_OPEN_ORDERS', openOrders: total, ...open } },
      );
  }

  /** Activation gate: every setup step done (422 with the missing items). */
  private async assertReady(tx: Tx, w: WarehouseRecord): Promise<void> {
    const facts = await this.setupFacts([w.id], tx);
    const steps = setupSteps(w, facts.get(w.id) ?? NO_FACTS);
    // One issue per missing item; the path names the wizard step (setup.review = imported data
    // still to confirm, the REVIEW_PENDING case).
    const issues = steps.flatMap((s) =>
      s.issues.map((message) => ({ path: `setup.${s.key}`, message })),
    );
    if (issues.length > 0)
      throw new ValidationError(issues, 'The warehouse is not ready to activate');
  }

  /** MOTHER: never a parent. DEPOT: the given live mother, else the single live mother. */
  private async parentFor(
    tx: Tx,
    type: 'MOTHER' | 'DEPOT',
    requested: string | null | undefined,
    selfId?: string,
  ): Promise<string | null> {
    if (type === 'MOTHER') {
      if (requested != null)
        throw new ValidationError([
          { path: 'body.parentWarehouseId', message: 'a central warehouse has no parent' },
        ]);
      return null;
    }
    const mother = await this.repo.liveMother(tx);
    if (requested == null) return mother?.id ?? null;
    if (requested === selfId || mother?.id !== requested)
      throw new ValidationError([
        { path: 'body.parentWarehouseId', message: 'must be the live central warehouse' },
      ]);
    return requested;
  }

  /**
   * A unique violation that raced past the pre-checks: re-read to say which rule it broke (the
   * driver adapter does not name the index). Errors that already carry a reason pass through.
   */
  private async explainConflict(error: unknown, newCode?: string): Promise<unknown> {
    if (!(error instanceof ConflictError)) return error;
    if ((error.details as { reason?: string } | undefined)?.reason !== undefined) return error;
    if (newCode !== undefined && (await this.repo.codeExists(newCode))) return DUPLICATE_CODE();
    return CENTRAL_EXISTS();
  }

  private assertState(stateCode: string): void {
    if (!STATE_CODES.includes(stateCode))
      throw new ValidationError([{ path: 'body.stateCode', message: 'unknown GST state code' }]);
  }

  private emitUpserted(
    tx: Tx,
    w: WarehouseRecord,
    correlationId: string,
    deleted = false,
  ): Promise<void> {
    const data: WarehouseUpsertedV1 = {
      warehouseId: w.id,
      version: w.version,
      code: w.code,
      name: w.name,
      type: w.type,
      status: w.status,
      parentWarehouseId: w.parentWarehouseId,
      addressLine: w.addressLine,
      city: w.city,
      district: w.district,
      stateCode: w.stateCode,
      pinCode: w.pinCode,
      latitude: w.latitude,
      longitude: w.longitude,
      temperatureClasses: w.temperatureClasses,
      isAllocatable: w.isAllocatable,
      priority: w.priority,
      deleted,
    };
    return emitWarehouseEvent(tx, WAREHOUSE_EVENTS.upserted, data, correlationId);
  }
}

const pick = (row: WarehouseRecord, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(
    keys
      .filter((k) => k !== 'searchText' && k !== 'updatedByUserId')
      .map((k) => [k, (row as unknown as Record<string, unknown>)[k]]),
  );
