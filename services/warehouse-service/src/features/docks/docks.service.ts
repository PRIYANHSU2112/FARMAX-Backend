import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import { dayBounds, localDate } from '../../middleware/time.js';
import type { Actor, AuditEntry } from '../audit/index.js';
import type { BookingRow, DoorRow, SlotRow, StagingRow } from './docks.repository.js';
import type {
  BookingInput,
  BookingView,
  CapacityUnit,
  DockYardSummary,
  DoorInput,
  DoorUpdate,
  DoorView,
  StagingInput,
  YardSlotInput,
} from './docks.types.js';

const actorOf = (c: Caller): Actor => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });

const dockBusy = () =>
  new ConflictError('The dock door is booked for that time', { details: { reason: 'DOCK_BUSY' } });
const duplicate = (what: string, code: string) =>
  new ConflictError(`${what} ${code} already exists in this warehouse`, {
    details: { reason: 'DUPLICATE_CODE' },
  });
const invalidTransition = (status: string) =>
  new ConflictError(`Not allowed while ${status}`, {
    details: { reason: 'INVALID_TRANSITION', status },
  });

/** Error text incl. causes / driver meta (Prisma 7 adapter errors do not name the constraint on top). */
const errorText = (v: unknown, depth = 0): string => {
  if (v === null || v === undefined || depth > 4) return '';
  if (v instanceof Error) {
    const e = v as Error & { cause?: unknown; meta?: unknown; code?: string };
    return [
      e.message,
      e.code ?? '',
      errorText(e.meta, depth + 1),
      errorText(e.cause, depth + 1),
    ].join(' ');
  }
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
};

/** The exclusion constraint fired (race past the locked pre-check). Exported for the DB test. */
export const isOverlapViolation = (error: unknown): boolean =>
  /warehouse_dock_bookings_no_overlap|23P01|exclusion constraint/i.test(errorText(error));

const bookingView = (b: BookingRow): BookingView => ({
  id: b.id,
  dockDoorId: b.dockDoorId,
  doorCode: b.door.code,
  direction: b.direction,
  refNo: b.refNo,
  loadQty: num(b.loadQty).toFixed(2),
  loadUnit: b.loadUnit,
  plannedStart: b.plannedStart.toISOString(),
  plannedEnd: b.plannedEnd.toISOString(),
  status: b.status,
  startedAt: b.startedAt?.toISOString() ?? null,
  endedAt: b.endedAt?.toISOString() ?? null,
});

const doorView = (d: DoorRow, inUse?: BookingRow): DoorView => ({
  id: d.id,
  code: d.code,
  name: d.name,
  type: d.type,
  vehicleClass: d.vehicleClass,
  capacityPerDay: num(d.capacityPerDay).toFixed(2),
  equipment: d.equipment,
  capacityUnit: d.capacityUnit,
  opensAt: d.opensAt,
  closesAt: d.closesAt,
  status: d.status,
  displayStatus: d.status !== 'ACTIVE' ? d.status : inUse === undefined ? 'AVAILABLE' : 'BUSY',
  currentUse:
    inUse === undefined
      ? null
      : {
          bookingId: inUse.id,
          refNo: inUse.refNo,
          loadQty: num(inUse.loadQty).toFixed(2),
          loadUnit: inUse.loadUnit,
        },
  version: d.version,
});

const slotView = (s: SlotRow) => ({
  ...s,
  occupiedSince: s.occupiedSince?.toISOString() ?? null,
});

/**
 * Today's unloading capacity per unit (W2.07): total = active unloading doors' daily capacity;
 * planned = today's non-cancelled inbound bookings; used = in use or done. Tonnes and pallets are
 * separate entries, never added or converted.
 */
export function unloadingCapacity(
  doors: readonly DoorRow[],
  bookings: readonly BookingRow[],
): DockYardSummary['unloadingCapacity'] {
  const units = new Map<CapacityUnit, { total: number; planned: number; used: number }>();
  const entry = (u: CapacityUnit) => {
    const e = units.get(u) ?? { total: 0, planned: 0, used: 0 };
    units.set(u, e);
    return e;
  };
  for (const d of doors)
    if (d.status === 'ACTIVE' && d.type !== 'LOADING')
      entry(d.capacityUnit).total += num(d.capacityPerDay);
  for (const b of bookings) {
    if (b.direction !== 'INBOUND' || b.status === 'CANCELLED') continue;
    const e = entry(b.loadUnit);
    e.planned += num(b.loadQty);
    if (b.status === 'IN_USE' || b.status === 'DONE') e.used += num(b.loadQty);
  }
  return [...units]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([unit, e]) => ({
      unit,
      total: e.total.toFixed(2),
      planned: e.planned.toFixed(2),
      used: e.used.toFixed(2),
      available: Math.max(e.total - e.planned, 0).toFixed(2),
      usedPct: e.total <= 0 ? 0 : Math.round((e.used / e.total) * 1000) / 10,
    }));
}

/**
 * Dock & yard (W2.07, D-56): doors and their bookings (manual until Gate, W5, creates them),
 * staging areas and yard slots. Bookings are serialised per door (row lock) and the database
 * refuses overlapping open bookings (exclusion constraint).
 */
export class DocksService {
  private readonly repo: Cradle['docksRepository'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly auditService: Cradle['auditService'];
  private readonly lazy: Pick<Cradle, 'warehousesService'>;

  constructor(
    deps: Pick<
      Cradle,
      'docksRepository' | 'runInTransaction' | 'auditService' | 'warehousesService'
    >,
  ) {
    this.repo = deps.docksRepository;
    this.runInTransaction = deps.runInTransaction;
    this.auditService = deps.auditService;
    this.lazy = deps;
  }

  // ── Summary and lists ──

  async summary(caller: Caller, warehouseId: string): Promise<DockYardSummary> {
    const w = await this.visible(caller, warehouseId, 'warehouse.view');
    const date = localDate(new Date(), w.timezone);
    const { from, to } = dayBounds(date, w.timezone);
    const [doors, inUse, bookings, staging, slots] = await Promise.all([
      this.repo.doors(warehouseId),
      this.repo.inUse(warehouseId),
      this.repo.bookingsBetween(warehouseId, from, to),
      this.repo.staging(warehouseId),
      this.repo.slots(warehouseId),
    ]);
    const busy = new Set(inUse.map((b) => b.dockDoorId));
    return {
      date,
      doors: {
        total: doors.length,
        active: doors.filter((d) => d.status === 'ACTIVE' && !busy.has(d.id)).length,
        busy: doors.filter((d) => d.status === 'ACTIVE' && busy.has(d.id)).length,
        inactive: doors.filter((d) => d.status !== 'ACTIVE').length,
      },
      staging: {
        count: staging.length,
        totalPallets: staging
          .filter((s) => s.status === 'ACTIVE')
          .reduce((n, s) => n + s.capacityPallets, 0),
      },
      yard: {
        total: slots.length,
        available: slots.filter((s) => s.status === 'AVAILABLE').length,
        occupied: slots.filter((s) => s.status === 'OCCUPIED').length,
        blocked: slots.filter((s) => s.status === 'BLOCKED').length,
      },
      unloadingCapacity: unloadingCapacity(doors, bookings),
    };
  }

  async doors(caller: Caller, warehouseId: string): Promise<DoorView[]> {
    await this.visible(caller, warehouseId, 'warehouse.view');
    const [doors, inUse] = await Promise.all([
      this.repo.doors(warehouseId),
      this.repo.inUse(warehouseId),
    ]);
    const byDoor = new Map(inUse.map((b) => [b.dockDoorId, b] as const));
    return doors.map((d) => doorView(d, byDoor.get(d.id)));
  }

  /** One local day of bookings (default today in the warehouse timezone). */
  async bookings(caller: Caller, warehouseId: string, date?: string): Promise<BookingView[]> {
    const w = await this.visible(caller, warehouseId, 'warehouse.view');
    const { from, to } = dayBounds(date ?? localDate(new Date(), w.timezone), w.timezone);
    return (await this.repo.bookingsBetween(warehouseId, from, to)).map(bookingView);
  }

  /** Door id → code (dispatch views; no caller). */
  async doorCodes(ids: readonly string[]) {
    if (ids.length === 0) return [];
    const rows = await this.repo.doorsByIds(ids);
    return rows.map((d) => ({ id: d.id, code: d.code }));
  }

  /** Doors of a warehouse with equipment (W3.19 bays; caller checked by the dispatch module). */
  async doorsFacts(warehouseId: string) {
    const rows = await this.repo.doors(warehouseId);
    return rows.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      equipment: d.equipment,
      vehicleClass: d.vehicleClass,
      status: d.status,
    }));
  }

  /** Staging capacity and docks in use (fulfilment dashboards; no caller, scope given). */
  floorFacts(warehouseIds: readonly string[] | 'ALL') {
    return this.repo.floorFacts(warehouseIds);
  }

  async staging(caller: Caller, warehouseId: string): Promise<StagingRow[]> {
    await this.visible(caller, warehouseId, 'warehouse.view');
    return this.repo.staging(warehouseId);
  }

  async slots(caller: Caller, warehouseId: string) {
    await this.visible(caller, warehouseId, 'warehouse.view');
    return (await this.repo.slots(warehouseId)).map(slotView);
  }

  /** Which of `ids` are doors of this warehouse (calendar shifts). */
  existingDoorIds(warehouseId: string, ids: readonly string[], tx?: Tx): Promise<string[]> {
    return this.repo.existingDoorIds(warehouseId, ids, tx);
  }

  // ── Doors ──

  async createDoor(caller: Caller, warehouseId: string, input: DoorInput): Promise<DoorView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    this.assertHours(input.opensAt, input.closesAt);
    return this.runInTransaction(async (tx) => {
      if (await this.repo.doorCodeExists(tx, warehouseId, input.code))
        throw duplicate('Dock door', input.code);
      const d = await this.repo.createDoor(tx, {
        warehouseId,
        ...input,
        opensAt: input.opensAt ?? null,
        closesAt: input.closesAt ?? null,
        createdByUserId: caller.userId,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'dock_door.create',
        targetType: 'dock_door',
        targetId: d.id,
        after: d,
      });
      return doorView(d);
    });
  }

  async updateDoor(
    caller: Caller,
    warehouseId: string,
    doorId: string,
    input: DoorUpdate,
  ): Promise<DoorView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    const { expectedVersion, ...changes } = input;
    return this.runInTransaction(async (tx) => {
      const before = await this.repo.lockDoor(tx, warehouseId, doorId);
      if (before === null) throw new NotFoundError('Dock door');
      if (before.version !== expectedVersion)
        throw new ConflictError('Changed by someone else; reload and retry', {
          details: { reason: 'VERSION_CONFLICT', currentVersion: before.version },
        });
      this.assertHours(
        changes.opensAt === undefined ? before.opensAt : changes.opensAt,
        changes.closesAt === undefined ? before.closesAt : changes.closesAt,
      );
      if (
        changes.capacityUnit !== undefined &&
        changes.capacityUnit !== before.capacityUnit &&
        (await this.repo.countBookings(tx, doorId, true)) > 0
      )
        throw new ConflictError('Finish or cancel the open bookings before changing the unit', {
          details: { reason: 'DOOR_HAS_BOOKINGS' },
        });
      const after = await this.repo.updateDoor(tx, doorId, {
        ...changes,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'dock_door.update',
        targetType: 'dock_door',
        targetId: doorId,
        before,
        after: changes,
      });
      return doorView(after);
    });
  }

  /** Doors with booking history are deactivated instead (the history stays). */
  async deleteDoor(caller: Caller, warehouseId: string, doorId: string): Promise<void> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx) => {
      const d = await this.repo.lockDoor(tx, warehouseId, doorId);
      if (d === null) throw new NotFoundError('Dock door');
      if ((await this.repo.countBookings(tx, doorId, false)) > 0)
        throw new ConflictError('The door has bookings; set it INACTIVE instead', {
          details: { reason: 'DOOR_HAS_BOOKINGS' },
        });
      await this.repo.deleteDoor(tx, doorId);
      await this.audit(tx, caller, {
        action: 'dock_door.delete',
        targetType: 'dock_door',
        targetId: doorId,
        before: { code: d.code },
      });
    });
  }

  // ── Bookings ──

  async book(
    caller: Caller,
    warehouseId: string,
    doorId: string,
    input: BookingInput,
  ): Promise<BookingView> {
    await this.visible(caller, warehouseId, 'warehouse.operate');
    const start = new Date(input.plannedStart);
    const end = new Date(input.plannedEnd);
    if (end <= start)
      throw new ValidationError([
        { path: 'body.plannedEnd', message: 'must be after plannedStart' },
      ]);
    try {
      return await this.runInTransaction(async (tx) => {
        const door = await this.repo.lockDoor(tx, warehouseId, doorId);
        if (door === null) throw new NotFoundError('Dock door');
        if (door.status !== 'ACTIVE')
          throw new ConflictError('The dock door is not active', {
            details: { reason: 'DOOR_INACTIVE' },
          });
        const fits =
          door.type === 'BOTH' ||
          (input.direction === 'INBOUND' ? door.type === 'UNLOADING' : door.type === 'LOADING');
        if (!fits)
          throw new ValidationError([
            {
              path: 'body.direction',
              message: `a ${door.type} door cannot take ${input.direction}`,
            },
          ]);
        if ((await this.repo.overlapping(tx, doorId, start, end)).length > 0) throw dockBusy();
        const b = await this.repo.createBooking(tx, {
          warehouseId,
          dockDoorId: doorId,
          direction: input.direction,
          refNo: input.refNo,
          loadQty: input.loadQty,
          loadUnit: door.capacityUnit,
          plannedStart: start,
          plannedEnd: end,
          createdByUserId: caller.userId,
          updatedByUserId: caller.userId,
        });
        await this.audit(tx, caller, {
          action: 'dock_booking.create',
          targetType: 'dock_booking',
          targetId: b.id,
          after: bookingView(b),
        });
        return bookingView(b);
      });
    } catch (error) {
      if (isOverlapViolation(error)) throw dockBusy();
      throw error;
    }
  }

  /** start: PLANNED → IN_USE (door BUSY) · complete: IN_USE → DONE · cancel: open → CANCELLED. */
  async moveBooking(
    caller: Caller,
    warehouseId: string,
    bookingId: string,
    action: 'start' | 'complete' | 'cancel',
  ): Promise<BookingView> {
    await this.visible(caller, warehouseId, 'warehouse.operate');
    return this.runInTransaction(async (tx) => {
      const found = await this.repo.lockBooking(tx, warehouseId, bookingId);
      if (found === null) throw new NotFoundError('Dock booking');
      await this.repo.lockDoor(tx, warehouseId, found.dockDoorId);
      const b = (await this.repo.lockBooking(tx, warehouseId, bookingId)) ?? found;
      const now = new Date();
      let data: { status: 'IN_USE' | 'DONE' | 'CANCELLED'; startedAt?: Date; endedAt?: Date };
      if (action === 'start') {
        if (b.status !== 'PLANNED') throw invalidTransition(b.status);
        const busy = (await this.repo.inUse(warehouseId, tx)).some(
          (x) => x.dockDoorId === b.dockDoorId,
        );
        if (busy) throw dockBusy();
        data = { status: 'IN_USE', startedAt: now };
      } else if (action === 'complete') {
        if (b.status !== 'IN_USE') throw invalidTransition(b.status);
        data = { status: 'DONE', endedAt: now };
      } else {
        if (b.status !== 'PLANNED' && b.status !== 'IN_USE') throw invalidTransition(b.status);
        data = { status: 'CANCELLED', endedAt: now };
      }
      const after = await this.repo.updateBooking(tx, bookingId, {
        ...data,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: `dock_booking.${action}`,
        targetType: 'dock_booking',
        targetId: bookingId,
        before: { status: b.status },
        after: { status: after.status },
      });
      return bookingView(after);
    });
  }

  // ── Staging ──

  async createStaging(
    caller: Caller,
    warehouseId: string,
    input: StagingInput,
  ): Promise<StagingRow> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    return this.runInTransaction(async (tx) => {
      if (
        (await this.repo.staging(warehouseId)).some(
          (s) => s.name.toLowerCase() === input.name.toLowerCase(),
        )
      )
        throw duplicate('Staging area', input.name);
      const s = await this.repo.createStaging(tx, {
        warehouseId,
        ...input,
        createdByUserId: caller.userId,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'staging_area.create',
        targetType: 'staging_area',
        targetId: s.id,
        after: s,
      });
      return s;
    });
  }

  async updateStaging(
    caller: Caller,
    warehouseId: string,
    id: string,
    input: Partial<StagingInput>,
  ): Promise<StagingRow> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    return this.runInTransaction(async (tx) => {
      const before = await this.repo.findStaging(warehouseId, id, tx);
      if (before === null) throw new NotFoundError('Staging area');
      const after = await this.repo.updateStaging(tx, id, {
        ...input,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'staging_area.update',
        targetType: 'staging_area',
        targetId: id,
        before,
        after: input,
      });
      return after;
    });
  }

  async deleteStaging(caller: Caller, warehouseId: string, id: string): Promise<void> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx) => {
      const before = await this.repo.findStaging(warehouseId, id, tx);
      if (before === null) throw new NotFoundError('Staging area');
      await this.repo.deleteStaging(tx, id);
      await this.audit(tx, caller, {
        action: 'staging_area.delete',
        targetType: 'staging_area',
        targetId: id,
        before,
      });
    });
  }

  // ── Yard ──

  async createSlot(caller: Caller, warehouseId: string, input: YardSlotInput) {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    return this.runInTransaction(async (tx) => {
      if ((await this.repo.slots(warehouseId)).some((s) => s.code === input.code))
        throw duplicate('Yard slot', input.code);
      const s = await this.repo.createSlot(tx, {
        warehouseId,
        ...input,
        createdByUserId: caller.userId,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'yard_slot.create',
        targetType: 'yard_slot',
        targetId: s.id,
        after: s,
      });
      return slotView(s);
    });
  }

  /** Configure a slot (vehicle class, AVAILABLE ↔ BLOCKED); occupancy has its own actions. */
  async updateSlot(
    caller: Caller,
    warehouseId: string,
    id: string,
    input: Partial<Omit<YardSlotInput, 'code'>>,
  ) {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    return this.runInTransaction(async (tx) => {
      const before = await this.repo.lockSlot(tx, warehouseId, id);
      if (before === null) throw new NotFoundError('Yard slot');
      if (input.status !== undefined && before.status === 'OCCUPIED')
        throw invalidTransition('OCCUPIED');
      const after = await this.repo.updateSlot(tx, id, {
        ...input,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'yard_slot.update',
        targetType: 'yard_slot',
        targetId: id,
        before,
        after: input,
      });
      return slotView(after);
    });
  }

  async deleteSlot(caller: Caller, warehouseId: string, id: string): Promise<void> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx) => {
      const before = await this.repo.lockSlot(tx, warehouseId, id);
      if (before === null) throw new NotFoundError('Yard slot');
      if (before.status === 'OCCUPIED') throw invalidTransition('OCCUPIED');
      await this.repo.deleteSlot(tx, id);
      await this.audit(tx, caller, {
        action: 'yard_slot.delete',
        targetType: 'yard_slot',
        targetId: id,
        before,
      });
    });
  }

  /** occupy: AVAILABLE → OCCUPIED (vehicle number) · release: OCCUPIED → AVAILABLE. */
  async occupy(caller: Caller, warehouseId: string, id: string, vehicleNo: string | null) {
    await this.visible(caller, warehouseId, 'warehouse.operate');
    return this.runInTransaction(async (tx) => {
      const before = await this.repo.lockSlot(tx, warehouseId, id);
      if (before === null) throw new NotFoundError('Yard slot');
      const occupying = vehicleNo !== null;
      if (occupying ? before.status !== 'AVAILABLE' : before.status !== 'OCCUPIED')
        throw invalidTransition(before.status);
      const after = await this.repo.updateSlot(tx, id, {
        status: occupying ? 'OCCUPIED' : 'AVAILABLE',
        occupiedByRef: vehicleNo,
        occupiedSince: occupying ? new Date() : null,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: occupying ? 'yard_slot.occupy' : 'yard_slot.release',
        targetType: 'yard_slot',
        targetId: id,
        before: { status: before.status, ref: before.occupiedByRef },
        after: { status: after.status, ref: after.occupiedByRef },
      });
      return slotView(after);
    });
  }

  // ── Helpers ──

  private assertHours(
    opensAt: string | null | undefined,
    closesAt: string | null | undefined,
  ): void {
    if ((opensAt == null) !== (closesAt == null))
      throw new ValidationError([
        { path: 'body.closesAt', message: 'give both opening and closing times' },
      ]);
  }

  private visible(caller: Caller, warehouseId: string, key: string) {
    return this.lazy.warehousesService.requireVisible(caller, warehouseId, key);
  }

  private audit(tx: Tx, caller: Caller, entry: AuditEntry): Promise<void> {
    return this.auditService.record(tx, actorOf(caller), entry);
  }
}
