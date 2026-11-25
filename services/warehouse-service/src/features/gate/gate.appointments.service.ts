import { NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import type { Paging } from '../../middleware/paging.js';
import { dayBounds, localIsoDay, localMidnight, localTime } from '../../middleware/time.js';
import { type DockBookingRow, isOverlapViolation } from '../docks/index.js';
import type { WarehouseRecord } from '../warehouses/index.js';
import { conflict } from './gate.support.js';

export interface BookInput {
  warehouseId: string;
  vendorId: string;
  restockRequestId?: string | null;
  asnId?: string | null;
  inboundShipmentId?: string | null;
  slotStart: string;
  dockDoorId: string;
  loadQty?: number | null;
}

type ApptStatus = 'CONFIRMED' | 'EXPECTED' | 'DELAYED' | 'IN_USE' | 'DONE' | 'CANCELLED';
const STATUS_LABEL: Record<ApptStatus, string> = {
  CONFIRMED: 'Confirmed',
  EXPECTED: 'Expected',
  DELAYED: 'Delayed',
  IN_USE: 'In use',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};

const dockBusy = () => conflict('DOCK_BUSY', 'The dock door is booked for that time');

/**
 * Dock appointment scheduling (W5.11, D-62): INBOUND bookings of the existing dock doors (their
 * exclusion constraint forbids overlaps). The slot grid = operating hours × `gate.slotMinutes`;
 * "Delayed" is computed at read time (planned start + grace passed, truck not arrived). Actual dock
 * times never change the booked window.
 */
export class GateAppointmentsService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'gateRepository'
      | 'gateRegistersRepository'
      | 'gateSupport'
      | 'docksService'
      | 'calendarService'
      | 'stockService'
      | 'restockService'
      | 'runInTransaction'
    >,
  ) {}

  private get support() {
    return this.deps.gateSupport;
  }

  private statusOf(b: DockBookingRow, now: Date, graceMs: number): ApptStatus {
    if (b.status === 'CANCELLED') return 'CANCELLED';
    if (b.status === 'DONE') return 'DONE';
    if (b.status === 'IN_USE') return 'IN_USE';
    if (b.plannedStart.getTime() + graceMs < now.getTime()) return 'DELAYED';
    return b.confirmedAt !== null ? 'CONFIRMED' : 'EXPECTED';
  }

  private async day(w: WarehouseRecord, date: string | undefined) {
    const d = date ?? this.support.today(w).date;
    return { date: d, ...dayBounds(d, w.timezone) };
  }

  /** Slot start times of a day from the weekly hours (default 09:00–18:00). */
  private async times(w: WarehouseRecord, date: string, slotMinutes: number) {
    const cal = await this.deps.calendarService.slaCalendar(w.id);
    const midnight = localMidnight(date, w.timezone);
    const iso = localIsoDay(new Date(midnight.getTime() + 12 * 3600_000), w.timezone);
    const h = cal.hours.find((x) => x.isoDay === iso);
    if (cal.closed.has(date) || (h !== undefined && !h.isOpen)) return [];
    const toMin = (t: string | null, def: number) => {
      if (t === null) return def;
      const [hh = 0, mm = 0] = t.split(':').map(Number);
      return hh * 60 + mm;
    };
    const open = toMin(h?.opensAt ?? null, 9 * 60);
    const close = toMin(h?.closesAt ?? null, 18 * 60);
    const out: Date[] = [];
    for (let m = open; m + slotMinutes <= close; m += slotMinutes)
      out.push(new Date(midnight.getTime() + m * 60_000));
    return out;
  }

  private async load(w: WarehouseRecord, from: Date, to: Date) {
    const [doors, bookings] = await Promise.all([
      this.deps.docksService.inboundDoors(w.id),
      this.deps.docksService.inboundBookings(w.id, from, to),
    ]);
    return { doors, bookings };
  }

  async summary(caller: Caller, warehouseId: string, date?: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    const s = await this.support.settings(w.id);
    const d = await this.day(w, date);
    const [times, { doors, bookings }] = await Promise.all([
      this.times(w, d.date, s['gate.slotMinutes']),
      this.load(w, d.from, d.to),
    ]);
    const now = new Date();
    const grace = s['gate.delayGraceMinutes'] * 60_000;
    const live = bookings.filter((b) => b.status !== 'CANCELLED');
    const total = times.length * doors.length;
    const slotMs = s['gate.slotMinutes'] * 60_000;
    let taken = 0;
    for (const t of times)
      for (const door of doors)
        if (
          live.some(
            (b) =>
              b.dockDoorId === door.id &&
              b.plannedStart.getTime() < t.getTime() + slotMs &&
              b.plannedEnd.getTime() > t.getTime(),
          )
        )
          taken += 1;
    const statuses = live.map((b) => this.statusOf(b, now, grace));
    return {
      date: d.date,
      todaySlots: { value: total, confirmed: statuses.filter((x) => x === 'CONFIRMED').length },
      booked: { value: live.length, caption: 'Vendor appointments' },
      available: { value: Math.max(total - taken, 0), caption: 'Open slot capacity' },
      delayed: {
        value: statuses.filter((x) => x === 'DELAYED').length,
        caption: 'Needs attention',
      },
    };
  }

  /** W5.11 time-slot strip: per slot the first free door, or the booked bay. */
  async slots(caller: Caller, warehouseId: string, date?: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    const s = await this.support.settings(w.id);
    const d = await this.day(w, date);
    const [times, { doors, bookings }, inUse] = await Promise.all([
      this.times(w, d.date, s['gate.slotMinutes']),
      this.load(w, d.from, d.to),
      this.deps.docksService.inUseNow(w.id),
    ]);
    const slotMs = s['gate.slotMinutes'] * 60_000;
    const live = bookings.filter((b) => b.status !== 'CANCELLED');
    const now = Date.now();
    return {
      date: d.date,
      slotMinutes: s['gate.slotMinutes'],
      slots: times.map((t) => {
        const end = t.getTime() + slotMs;
        const perDoor = doors.map((door) => {
          const b = live.find(
            (x) =>
              x.dockDoorId === door.id &&
              x.plannedStart.getTime() < end &&
              x.plannedEnd.getTime() > t.getTime(),
          );
          // Actual occupancy past the booked window (never written into the window).
          const overrun =
            b === undefined &&
            t.getTime() <= now &&
            now < end &&
            inUse.some((x) => x.dockDoorId === door.id && x.plannedEnd.getTime() <= t.getTime());
          return {
            dockDoorId: door.id,
            code: door.code,
            status:
              b === undefined
                ? overrun
                  ? 'OVERRUN'
                  : 'AVAILABLE'
                : b.confirmedAt !== null
                  ? 'CONFIRMED'
                  : 'BOOKED',
            bookingId: b?.id ?? null,
            refNo: b?.refNo ?? null,
          };
        });
        const free = perDoor.find((x) => x.status === 'AVAILABLE');
        const booked = perDoor.find((x) => x.status !== 'AVAILABLE');
        return {
          time: localTime(t, w.timezone),
          start: t.toISOString(),
          end: new Date(end).toISOString(),
          status: free === undefined ? 'BOOKED' : 'AVAILABLE',
          label: free === undefined ? (booked?.code ?? 'Booked') : 'Inbound dock',
          freeDoors: perDoor.filter((x) => x.status === 'AVAILABLE').length,
          doors: perDoor,
        };
      }),
    };
  }

  async list(caller: Caller, warehouseId: string, date: string | undefined, p: Paging) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    const s = await this.support.settings(w.id);
    const d = await this.day(w, date);
    const { bookings } = await this.load(w, d.from, d.to);
    const now = new Date();
    const grace = s['gate.delayGraceMinutes'] * 60_000;
    const vendors = new Map(
      (
        await this.deps.stockService.vendorFacts(
          bookings.flatMap((b) => (b.vendorId === null ? [] : [b.vendorId])),
        )
      ).map((v) => [v.id, v]),
    );
    // A day holds at most a few hundred appointments: offset cursor over the day's list.
    const start =
      p.cursor === undefined ? 0 : Number(Buffer.from(p.cursor, 'base64url').toString('utf8')) || 0;
    const slice = bookings.slice(start, start + p.limit);
    return {
      limit: p.limit,
      nextCursor:
        bookings.length > start + p.limit
          ? Buffer.from(String(start + p.limit)).toString('base64url')
          : null,
      total: bookings.length,
      items: slice.map((b) => {
        const st = this.statusOf(b, now, grace);
        return {
          id: b.id,
          time: localTime(b.plannedStart, w.timezone),
          plannedStart: b.plannedStart.toISOString(),
          plannedEnd: b.plannedEnd.toISOString(),
          vendor:
            b.vendorId === null
              ? null
              : {
                  id: b.vendorId,
                  code: vendors.get(b.vendorId)?.code ?? null,
                  name: vendors.get(b.vendorId)?.name ?? null,
                },
          ref: b.refNo,
          inboundShipmentId: b.inboundShipmentId,
          asnId: b.asnId,
          dock: { id: b.dockDoorId, code: b.door.code },
          status: st,
          statusLabel: STATUS_LABEL[st],
          action: st === 'DELAYED' ? 'RESCHEDULE' : 'VIEW',
        };
      }),
    };
  }

  async bays(caller: Caller, warehouseId: string, date?: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    const d = await this.day(w, date);
    const [{ doors, bookings }, inUse] = await Promise.all([
      this.load(w, d.from, d.to),
      this.deps.docksService.inUseNow(w.id),
    ]);
    const now = Date.now();
    return doors.map((door) => {
      const live = bookings.filter((b) => b.dockDoorId === door.id && b.status !== 'CANCELLED');
      const current = live.find(
        (b) => b.plannedStart.getTime() <= now && b.plannedEnd.getTime() > now,
      );
      const busy = inUse.some((b) => b.dockDoorId === door.id);
      const status = busy
        ? 'IN_USE'
        : current === undefined
          ? 'AVAILABLE'
          : current.confirmedAt !== null
            ? 'CONFIRMED'
            : 'BOOKED';
      return {
        id: door.id,
        code: door.code,
        name: door.name,
        description: door.equipment === 'WEIGHBRIDGE' ? 'Inbound weighbridge' : door.name,
        status,
        statusLabel: {
          IN_USE: 'In use',
          AVAILABLE: 'Available',
          CONFIRMED: 'Confirmed',
          BOOKED: 'Booked',
        }[status],
        bookingsToday: live.length,
      };
    });
  }

  async book(caller: Caller, input: BookInput) {
    const w = await this.support.warehouse(caller, input.warehouseId, 'gate.operate');
    const s = await this.support.settings(w.id);
    const vendor = (await this.deps.stockService.vendorFacts([input.vendorId]))[0];
    if (vendor === undefined)
      throw new ValidationError([{ path: 'body.vendorId', message: 'unknown vendor' }]);
    const start = new Date(input.slotStart);
    const end = new Date(start.getTime() + s['gate.slotMinutes'] * 60_000);
    const repo = this.deps.gateRepository;
    let id: string;
    try {
      id = await this.deps.runInTransaction(async (tx) => {
        let refNo: string;
        let poNo: string | null = null;
        if ((input.restockRequestId ?? null) !== null) {
          const po = await this.deps.restockService.procurement(input.restockRequestId ?? '', tx);
          if (po?.type !== 'PROCUREMENT' || po.destWarehouseId !== w.id)
            throw new ValidationError([
              { path: 'body.restockRequestId', message: 'is not a PO of this warehouse' },
            ]);
          poNo = po.requestNo;
        }
        let asnRef: string | null = null;
        if ((input.asnId ?? null) !== null) {
          const a = await this.deps.gateRegistersRepository.lockAsn(tx, input.asnId ?? '');
          if (a?.warehouseId !== w.id)
            throw new ValidationError([{ path: 'body.asnId', message: 'unknown ASN' }]);
          asnRef = a.vendorAsnRef;
        }
        let shipment = null;
        if ((input.inboundShipmentId ?? null) !== null) {
          shipment = await repo.lockShipment(tx, input.inboundShipmentId ?? '');
          if (shipment?.warehouseId !== w.id)
            throw new ValidationError([
              { path: 'body.inboundShipmentId', message: 'unknown shipment' },
            ]);
          if (shipment.stage !== 'EXPECTED')
            throw conflict('STALE_STATE', 'Only an expected shipment can be booked', {
              status: shipment.stage,
            });
          refNo = shipment.shipmentNo;
        } else refNo = [poNo, asnRef].filter((x) => x !== null).join(' / ') || vendor.code;
        const b = await this.deps.docksService.gateBook(tx, w.id, {
          dockDoorId: input.dockDoorId,
          start,
          end,
          refNo,
          loadQty: input.loadQty ?? 1,
          inboundShipmentId: shipment?.id ?? null,
          vendorId: vendor.id,
          asnId: input.asnId ?? null,
          userId: caller.userId,
        });
        if (shipment !== null) {
          if (shipment.dockBookingId !== null && shipment.dockBookingId !== b.id)
            await this.deps.docksService.gateMove(
              tx,
              w.id,
              shipment.dockBookingId,
              'cancel',
              caller.userId,
            );
          await repo.updateShipment(tx, shipment.id, {
            etaAt: start,
            dockDoorId: b.dockDoorId,
            bayCode: b.door.code,
            dockBookingId: b.id,
            rebookingRequired: false,
            updatedBy: caller.userId,
          });
          await this.support.event(tx, {
            warehouseId: w.id,
            shipmentId: shipment.id,
            type: 'APPOINTMENT_BOOKED',
            byUserId: caller.userId,
            data: {
              bay: b.door.code,
              slotStart: start.toISOString(),
              rebooked: shipment.rebookingRequired,
            },
          });
        }
        if ((input.asnId ?? null) !== null)
          await this.deps.gateRegistersRepository.updateAsn(tx, input.asnId ?? '', {
            dockBookingId: b.id,
          });
        await this.support.audit(tx, caller, 'gate.appointment_booked', 'dock_booking', b.id, {
          dockDoorId: b.dockDoorId,
          plannedStart: start.toISOString(),
          vendorId: vendor.id,
          inboundShipmentId: shipment?.id ?? null,
          asnId: input.asnId ?? null,
        });
        return b.id;
      });
    } catch (error) {
      if (isOverlapViolation(error)) throw dockBusy();
      throw error;
    }
    await this.support.bump(w.id);
    return this.view(w, id);
  }

  private async view(w: WarehouseRecord, id: string) {
    const b = await this.deps.docksService.booking(w.id, id);
    if (b === null) throw new NotFoundError('Dock appointment');
    const s = await this.support.settings(w.id);
    const st = this.statusOf(b, new Date(), s['gate.delayGraceMinutes'] * 60_000);
    return {
      id: b.id,
      dock: { id: b.dockDoorId, code: b.door.code },
      plannedStart: b.plannedStart.toISOString(),
      plannedEnd: b.plannedEnd.toISOString(),
      ref: b.refNo,
      vendorId: b.vendorId,
      inboundShipmentId: b.inboundShipmentId,
      asnId: b.asnId,
      confirmedAt: b.confirmedAt?.toISOString() ?? null,
      status: st,
      statusLabel: STATUS_LABEL[st],
    };
  }

  async get(caller: Caller, warehouseId: string, id: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    return this.view(w, id);
  }

  private async linked(
    tx: Parameters<Parameters<Cradle['runInTransaction']>[0]>[0],
    b: DockBookingRow,
  ) {
    if (b.inboundShipmentId === null) return null;
    const s = await this.deps.gateRepository.lockShipment(tx, b.inboundShipmentId);
    return s !== null && s.stage === 'EXPECTED' && s.dockBookingId === b.id ? s : null;
  }

  async reschedule(
    caller: Caller,
    warehouseId: string,
    id: string,
    input: { slotStart: string; dockDoorId?: string | null },
  ) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.operate');
    const s = await this.support.settings(w.id);
    const start = new Date(input.slotStart);
    try {
      await this.deps.runInTransaction(async (tx) => {
        const cur = await this.deps.docksService.booking(w.id, id, tx);
        if (cur?.direction !== 'INBOUND') throw new NotFoundError('Dock appointment');
        const b = await this.deps.docksService.gateReschedule(tx, w.id, id, {
          dockDoorId: input.dockDoorId ?? cur.dockDoorId,
          start,
          end: new Date(start.getTime() + s['gate.slotMinutes'] * 60_000),
          userId: caller.userId,
        });
        const ship = await this.linked(tx, b);
        if (ship !== null) {
          await this.deps.gateRepository.updateShipment(tx, ship.id, {
            etaAt: start,
            dockDoorId: b.dockDoorId,
            bayCode: b.door.code,
            updatedBy: caller.userId,
          });
          await this.support.event(tx, {
            warehouseId: w.id,
            shipmentId: ship.id,
            type: 'APPOINTMENT_RESCHEDULED',
            byUserId: caller.userId,
            data: { bay: b.door.code, slotStart: start.toISOString() },
          });
        }
        await this.support.audit(
          tx,
          caller,
          'gate.appointment_rescheduled',
          'dock_booking',
          id,
          { plannedStart: start.toISOString(), dockDoorId: b.dockDoorId },
          { plannedStart: cur.plannedStart.toISOString(), dockDoorId: cur.dockDoorId },
        );
      });
    } catch (error) {
      if (isOverlapViolation(error)) throw dockBusy();
      throw error;
    }
    await this.support.bump(w.id);
    return this.view(w, id);
  }

  async confirm(caller: Caller, warehouseId: string, id: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.operate');
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.deps.docksService.booking(w.id, id, tx);
      if (cur?.direction !== 'INBOUND') throw new NotFoundError('Dock appointment');
      if (cur.status !== 'PLANNED')
        throw conflict('STALE_STATE', `The appointment is ${cur.status.toLowerCase()}`);
      await this.deps.docksService.gateUpdate(tx, w.id, id, {
        confirmedAt: new Date(),
        userId: caller.userId,
      });
      await this.support.audit(tx, caller, 'gate.appointment_confirmed', 'dock_booking', id, {
        confirmed: true,
      });
    });
    await this.support.bump(w.id);
    return this.view(w, id);
  }

  async cancel(caller: Caller, warehouseId: string, id: string, reason: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.operate');
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.deps.docksService.booking(w.id, id, tx);
      if (cur?.direction !== 'INBOUND') throw new NotFoundError('Dock appointment');
      if (cur.status !== 'PLANNED')
        throw conflict('STALE_STATE', `The appointment is ${cur.status.toLowerCase()}`);
      const b = await this.deps.docksService.gateMove(tx, w.id, id, 'cancel', caller.userId);
      const ship = b === null ? null : await this.linked(tx, cur);
      if (ship !== null)
        await this.deps.gateRepository.updateShipment(tx, ship.id, {
          dockBookingId: null,
          dockDoorId: null,
          bayCode: null,
          updatedBy: caller.userId,
        });
      await this.support.audit(
        tx,
        caller,
        'gate.appointment_cancelled',
        'dock_booking',
        id,
        { status: 'CANCELLED' },
        { status: cur.status },
        reason,
      );
    });
    await this.support.bump(w.id);
    return this.view(w, id);
  }
}
