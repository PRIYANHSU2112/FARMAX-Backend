import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

const DOOR = {
  id: true,
  warehouseId: true,
  code: true,
  name: true,
  type: true,
  vehicleClass: true,
  capacityPerDay: true,
  equipment: true,
  capacityUnit: true,
  opensAt: true,
  closesAt: true,
  status: true,
  version: true,
} as const satisfies Prisma.WmsDockDoorSelect;

const BOOKING = {
  id: true,
  warehouseId: true,
  dockDoorId: true,
  direction: true,
  refNo: true,
  loadQty: true,
  loadUnit: true,
  plannedStart: true,
  plannedEnd: true,
  status: true,
  startedAt: true,
  endedAt: true,
  inboundShipmentId: true,
  vendorId: true,
  asnId: true,
  confirmedAt: true,
  door: { select: { code: true, name: true } },
} as const satisfies Prisma.WmsDockBookingSelect;

const STAGING = {
  id: true,
  name: true,
  kind: true,
  capacityPallets: true,
  temperatureClass: true,
  status: true,
} as const satisfies Prisma.WmsStagingAreaSelect;

const SLOT = {
  id: true,
  code: true,
  vehicleClass: true,
  status: true,
  occupiedByRef: true,
  occupiedSince: true,
} as const satisfies Prisma.WmsYardSlotSelect;

export type DoorRow = Prisma.WmsDockDoorGetPayload<{ select: typeof DOOR }>;
export type BookingRow = Prisma.WmsDockBookingGetPayload<{ select: typeof BOOKING }>;
export type StagingRow = Prisma.WmsStagingAreaGetPayload<{ select: typeof STAGING }>;
export type SlotRow = Prisma.WmsYardSlotGetPayload<{ select: typeof SLOT }>;
export type DoorWrite = Prisma.WmsDockDoorUncheckedUpdateInput;

const OPEN_STATUSES: ('PLANNED' | 'IN_USE')[] = ['PLANNED', 'IN_USE'];

/** Only place that touches dock doors, bookings, staging areas and yard slots. */
export class DocksRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── Doors ──

  doors(warehouseId: string): Promise<DoorRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsDockDoor.findMany({
        where: { warehouseId },
        select: DOOR,
        orderBy: { code: 'asc' },
      }),
    );
  }

  /** Row lock on a door: serialises its bookings (overlap check) and edits. */
  async lockDoor(tx: Tx, warehouseId: string, id: string): Promise<DoorRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_dock_doors" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return withPrismaErrors(() =>
      tx.wmsDockDoor.findFirst({ where: { id, warehouseId }, select: DOOR }),
    );
  }

  doorCodeExists(tx: Tx, warehouseId: string, code: string): Promise<boolean> {
    return withPrismaErrors(
      async () => (await tx.wmsDockDoor.count({ where: { warehouseId, code } })) > 0,
    );
  }

  createDoor(tx: Tx, data: Prisma.WmsDockDoorUncheckedCreateInput): Promise<DoorRow> {
    return withPrismaErrors(() => tx.wmsDockDoor.create({ data, select: DOOR }));
  }

  updateDoor(tx: Tx, id: string, data: DoorWrite): Promise<DoorRow> {
    return withPrismaErrors(() =>
      tx.wmsDockDoor.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        select: DOOR,
      }),
    );
  }

  async deleteDoor(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsDockDoor.delete({ where: { id } }));
  }

  /** Door ids of this warehouse among `ids` (shift dock lists). */
  async existingDoorIds(warehouseId: string, ids: readonly string[], tx?: Tx): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await withPrismaErrors(() =>
      (tx ?? this.db).wmsDockDoor.findMany({
        where: { warehouseId, id: { in: [...ids] } },
        select: { id: true },
      }),
    );
    return rows.map((r) => r.id);
  }

  // ── Bookings ──

  countBookings(tx: Tx, dockDoorId: string, openOnly: boolean): Promise<number> {
    return withPrismaErrors(() =>
      tx.wmsDockBooking.count({
        where: { dockDoorId, ...(openOnly ? { status: { in: OPEN_STATUSES } } : {}) },
      }),
    );
  }

  /** Open bookings of a door overlapping [start, end). */
  overlapping(tx: Tx, dockDoorId: string, start: Date, end: Date): Promise<BookingRow[]> {
    return withPrismaErrors(() =>
      tx.wmsDockBooking.findMany({
        where: {
          dockDoorId,
          status: { in: OPEN_STATUSES },
          plannedStart: { lt: end },
          plannedEnd: { gt: start },
        },
        select: BOOKING,
      }),
    );
  }

  inUse(warehouseId: string, tx?: Tx): Promise<BookingRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsDockBooking.findMany({
        where: { warehouseId, status: 'IN_USE' },
        select: BOOKING,
      }),
    );
  }

  doorsByIds(ids: readonly string[]) {
    return withPrismaErrors(() =>
      this.db.wmsDockDoor.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: { id: true, code: true },
      }),
    );
  }

  /** D-57b dashboards: Σ pallet capacity of ACTIVE staging areas + docks in use now. */
  async floorFacts(warehouseIds: readonly string[] | 'ALL') {
    const where = warehouseIds === 'ALL' ? {} : { warehouseId: { in: [...warehouseIds] } };
    const [cap, inUse, doors] = await Promise.all([
      this.db.wmsStagingArea.aggregate({
        where: { ...where, status: 'ACTIVE' },
        _sum: { capacityPallets: true },
      }),
      this.db.wmsDockBooking.count({ where: { ...where, status: 'IN_USE' } }),
      this.db.wmsDockDoor.count({ where: { ...where, status: 'ACTIVE' } }),
    ]);
    return {
      stagingCapacityPallets: cap._sum.capacityPallets ?? 0,
      docksInUse: inUse,
      activeDoors: doors,
    };
  }

  /** Bookings planned to start in [from, to), all statuses. */
  bookingsBetween(warehouseId: string, from: Date, to: Date): Promise<BookingRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsDockBooking.findMany({
        where: { warehouseId, plannedStart: { gte: from, lt: to } },
        select: BOOKING,
        orderBy: { plannedStart: 'asc' },
        take: 2_000,
      }),
    );
  }

  createBooking(tx: Tx, data: Prisma.WmsDockBookingUncheckedCreateInput): Promise<BookingRow> {
    return withPrismaErrors(() => tx.wmsDockBooking.create({ data, select: BOOKING }));
  }

  async lockBooking(tx: Tx, warehouseId: string, id: string): Promise<BookingRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_dock_bookings" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return withPrismaErrors(() =>
      tx.wmsDockBooking.findFirst({ where: { id, warehouseId }, select: BOOKING }),
    );
  }

  updateBooking(
    tx: Tx,
    id: string,
    data: Prisma.WmsDockBookingUncheckedUpdateInput,
  ): Promise<BookingRow> {
    return withPrismaErrors(() =>
      tx.wmsDockBooking.update({ where: { id }, data, select: BOOKING }),
    );
  }

  /** D-62 gate: ACTIVE doors that take INBOUND (UNLOADING or BOTH), by code. */
  inboundDoors(warehouseId: string): Promise<DoorRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsDockDoor.findMany({
        where: { warehouseId, status: 'ACTIVE', type: { in: ['UNLOADING', 'BOTH'] } },
        select: DOOR,
        orderBy: { code: 'asc' },
      }),
    );
  }

  /** D-62 gate: INBOUND bookings planned to start in [from, to), all statuses. */
  inboundBookingsBetween(warehouseId: string, from: Date, to: Date): Promise<BookingRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsDockBooking.findMany({
        where: { warehouseId, direction: 'INBOUND', plannedStart: { gte: from, lt: to } },
        select: BOOKING,
        orderBy: [{ plannedStart: 'asc' }, { id: 'asc' }],
        take: 2_000,
      }),
    );
  }

  booking(warehouseId: string, id: string, tx?: Tx): Promise<BookingRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsDockBooking.findFirst({ where: { id, warehouseId }, select: BOOKING }),
    );
  }

  // ── Staging ──

  staging(warehouseId: string): Promise<StagingRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsStagingArea.findMany({
        where: { warehouseId },
        select: STAGING,
        orderBy: { name: 'asc' },
      }),
    );
  }

  findStaging(warehouseId: string, id: string, tx?: Tx): Promise<StagingRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsStagingArea.findFirst({ where: { id, warehouseId }, select: STAGING }),
    );
  }

  createStaging(tx: Tx, data: Prisma.WmsStagingAreaUncheckedCreateInput): Promise<StagingRow> {
    return withPrismaErrors(() => tx.wmsStagingArea.create({ data, select: STAGING }));
  }

  updateStaging(
    tx: Tx,
    id: string,
    data: Prisma.WmsStagingAreaUncheckedUpdateInput,
  ): Promise<StagingRow> {
    return withPrismaErrors(() =>
      tx.wmsStagingArea.update({ where: { id }, data, select: STAGING }),
    );
  }

  async deleteStaging(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsStagingArea.delete({ where: { id } }));
  }

  // ── Yard ──

  slots(warehouseId: string): Promise<SlotRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsYardSlot.findMany({
        where: { warehouseId },
        select: SLOT,
        orderBy: { code: 'asc' },
      }),
    );
  }

  async lockSlot(tx: Tx, warehouseId: string, id: string): Promise<SlotRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_yard_slots" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return withPrismaErrors(() =>
      tx.wmsYardSlot.findFirst({ where: { id, warehouseId }, select: SLOT }),
    );
  }

  createSlot(tx: Tx, data: Prisma.WmsYardSlotUncheckedCreateInput): Promise<SlotRow> {
    return withPrismaErrors(() => tx.wmsYardSlot.create({ data, select: SLOT }));
  }

  updateSlot(tx: Tx, id: string, data: Prisma.WmsYardSlotUncheckedUpdateInput): Promise<SlotRow> {
    return withPrismaErrors(() => tx.wmsYardSlot.update({ where: { id }, data, select: SLOT }));
  }

  async deleteSlot(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsYardSlot.delete({ where: { id } }));
  }
}
