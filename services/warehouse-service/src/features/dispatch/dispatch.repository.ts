import { type Tx, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { WarehouseScope } from '../../middleware/access.js';

const TRIP = { shipments: { orderBy: { seq: 'asc' } } } as const satisfies Prisma.WmsTripInclude;
export type TripRow = Prisma.WmsTripGetPayload<{ include: typeof TRIP }>;
export type RouteRow = Prisma.WmsDispatchRouteGetPayload<object>;
export type VehicleRow = Prisma.WmsVehicleGetPayload<object>;
export type DriverRow = Prisma.WmsDriverGetPayload<object>;
export type CarrierRow = Prisma.WmsCarrierGetPayload<object>;
export type JsonInput = Prisma.InputJsonValue;

const scoped = (scope: WarehouseScope, warehouseId?: string) =>
  warehouseId !== undefined
    ? { warehouseId }
    : scope === 'ALL'
      ? {}
      : { warehouseId: { in: [...scope] } };

/** Only place that touches the dispatch tables (D-57b Phase 4a). */
export class DispatchRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── routes ──

  routes(scope: WarehouseScope, q: { warehouseId?: string; active?: boolean; q?: string }) {
    return withPrismaErrors(() =>
      this.db.wmsDispatchRoute.findMany({
        where: {
          ...scoped(scope, q.warehouseId),
          ...(q.active === undefined ? {} : { isActive: q.active }),
          ...(q.q === undefined
            ? {}
            : {
                OR: [
                  { code: { contains: q.q, mode: 'insensitive' } },
                  { name: { contains: q.q, mode: 'insensitive' } },
                ],
              }),
        },
        orderBy: [{ warehouseId: 'asc' }, { code: 'asc' }],
        take: 500,
      }),
    );
  }

  route(id: string, tx?: Tx): Promise<RouteRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).wmsDispatchRoute.findUnique({ where: { id } }));
  }

  routesByIds(ids: readonly string[]): Promise<RouteRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsDispatchRoute.findMany({ where: { id: { in: [...new Set(ids)] } } }),
    );
  }

  /** Active route of a warehouse whose PIN list holds the PIN. */
  routeForPin(warehouseId: string, pinCode: string, tx?: Tx) {
    return (tx ?? this.db).wmsDispatchRoute.findFirst({
      where: { warehouseId, isActive: true, pinCodes: { has: pinCode } },
      orderBy: { code: 'asc' },
    });
  }

  createRoute(tx: Tx, data: Prisma.WmsDispatchRouteUncheckedCreateInput) {
    return tx.wmsDispatchRoute.create({ data });
  }

  updateRoute(tx: Tx, id: string, data: Prisma.WmsDispatchRouteUncheckedUpdateInput) {
    return tx.wmsDispatchRoute.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  }

  // ── carriers / vehicles / drivers ──

  carriers(q: { type?: string; status?: string; q?: string }) {
    return withPrismaErrors(() =>
      this.db.wmsCarrier.findMany({
        where: {
          ...(q.type === undefined ? {} : { type: q.type as CarrierRow['type'] }),
          ...(q.status === undefined ? {} : { status: q.status as CarrierRow['status'] }),
          ...(q.q === undefined ? {} : { name: { contains: q.q, mode: 'insensitive' } }),
        },
        orderBy: { name: 'asc' },
        take: 500,
      }),
    );
  }

  carrier(id: string) {
    return withPrismaErrors(() => this.db.wmsCarrier.findUnique({ where: { id } }));
  }

  carriersByIds(ids: readonly string[]): Promise<CarrierRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsCarrier.findMany({ where: { id: { in: [...new Set(ids)] } } }),
    );
  }

  createCarrier(tx: Tx, data: Prisma.WmsCarrierUncheckedCreateInput) {
    return tx.wmsCarrier.create({ data });
  }

  updateCarrier(tx: Tx, id: string, data: Prisma.WmsCarrierUncheckedUpdateInput) {
    return tx.wmsCarrier.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  vehicles(
    scope: WarehouseScope,
    q: {
      warehouseId?: string;
      status?: string;
      carrierId?: string;
      q?: string;
      available?: boolean;
    },
  ) {
    return withPrismaErrors(() =>
      this.db.wmsVehicle.findMany({
        where: {
          ...(q.warehouseId !== undefined
            ? { OR: [{ warehouseId: q.warehouseId }, { warehouseId: null }] }
            : scope === 'ALL'
              ? {}
              : { OR: [{ warehouseId: { in: [...scope] } }, { warehouseId: null }] }),
          ...(q.status === undefined ? {} : { status: q.status as VehicleRow['status'] }),
          ...(q.carrierId === undefined ? {} : { carrierId: q.carrierId }),
          ...(q.q === undefined ? {} : { regNo: { contains: q.q.toUpperCase() } }),
        },
        orderBy: { regNo: 'asc' },
        take: 500,
      }),
    );
  }

  vehicle(id: string, tx?: Tx) {
    return withPrismaErrors(() => (tx ?? this.db).wmsVehicle.findUnique({ where: { id } }));
  }

  vehicleByReg(regNo: string, tx?: Tx) {
    return withPrismaErrors(() => (tx ?? this.db).wmsVehicle.findUnique({ where: { regNo } }));
  }

  vehiclesByIds(ids: readonly string[]): Promise<VehicleRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsVehicle.findMany({ where: { id: { in: [...new Set(ids)] } } }),
    );
  }

  createVehicle(tx: Tx, data: Prisma.WmsVehicleUncheckedCreateInput) {
    return tx.wmsVehicle.create({ data });
  }

  updateVehicle(tx: Tx, id: string, data: Prisma.WmsVehicleUncheckedUpdateInput) {
    return tx.wmsVehicle.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  drivers(
    scope: WarehouseScope,
    q: { warehouseId?: string; status?: string; carrierId?: string; q?: string },
  ) {
    return withPrismaErrors(() =>
      this.db.wmsDriver.findMany({
        where: {
          ...(q.warehouseId !== undefined
            ? { OR: [{ warehouseId: q.warehouseId }, { warehouseId: null }] }
            : scope === 'ALL'
              ? {}
              : { OR: [{ warehouseId: { in: [...scope] } }, { warehouseId: null }] }),
          ...(q.status === undefined ? {} : { status: q.status as DriverRow['status'] }),
          ...(q.carrierId === undefined ? {} : { carrierId: q.carrierId }),
          ...(q.q === undefined ? {} : { name: { contains: q.q, mode: 'insensitive' } }),
        },
        orderBy: { name: 'asc' },
        take: 500,
      }),
    );
  }

  driver(id: string, tx?: Tx) {
    return withPrismaErrors(() => (tx ?? this.db).wmsDriver.findUnique({ where: { id } }));
  }

  driversByIds(ids: readonly string[]): Promise<DriverRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsDriver.findMany({ where: { id: { in: [...new Set(ids)] } } }),
    );
  }

  createDriver(tx: Tx, data: Prisma.WmsDriverUncheckedCreateInput) {
    return tx.wmsDriver.create({ data });
  }

  updateDriver(tx: Tx, id: string, data: Prisma.WmsDriverUncheckedUpdateInput) {
    return tx.wmsDriver.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  // ── trips ──

  trip(id: string, tx?: Tx): Promise<TripRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsTrip.findUnique({ where: { id }, include: TRIP }),
    );
  }

  async lockTrip(tx: Tx, id: string): Promise<TripRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_dispatch_trips" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.trip(id, tx);
  }

  async createTrip(
    tx: Tx,
    data: Prisma.WmsTripUncheckedCreateInput,
    shipments: { shipmentId: string; seq: number; plannedKg: string | null }[],
  ): Promise<TripRow> {
    const t = await tx.wmsTrip.create({ data, select: { id: true } });
    if (shipments.length > 0)
      await tx.wmsTripShipment.createMany({ data: shipments.map((s) => ({ ...s, tripId: t.id })) });
    const row = await this.trip(t.id, tx);
    if (row === null) throw new Error('trip vanished');
    return row;
  }

  async addTripShipments(
    tx: Tx,
    tripId: string,
    shipments: { shipmentId: string; seq: number; plannedKg: string | null }[],
  ) {
    if (shipments.length > 0)
      await tx.wmsTripShipment.createMany({
        data: shipments.map((s) => ({ ...s, tripId })),
        skipDuplicates: true,
      });
  }

  async setLoadedKg(tx: Tx, tripId: string, shipmentId: string, loadedKg: string) {
    await tx.wmsTripShipment.update({
      where: { tripId_shipmentId: { tripId, shipmentId } },
      data: { loadedKg },
      select: { tripId: true },
    });
  }

  async removeTripShipment(tx: Tx, tripId: string, shipmentId: string) {
    await tx.wmsTripShipment.delete({ where: { tripId_shipmentId: { tripId, shipmentId } } });
  }

  async updateTrip(tx: Tx | undefined, id: string, data: Prisma.WmsTripUncheckedUpdateInput) {
    await (tx ?? this.db).wmsTrip.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      select: { id: true },
    });
  }

  trips(
    scope: WarehouseScope,
    q: {
      warehouseId?: string;
      status?: string;
      type?: string;
      vehicleId?: string;
      q?: string;
      cursor?: string;
      limit: number;
      offset: number | null;
    },
  ) {
    return withPrismaErrors(() =>
      this.db.wmsTrip.findMany({
        where: {
          ...scoped(scope, q.warehouseId),
          ...(q.status === undefined ? {} : { status: q.status as TripRow['status'] }),
          ...(q.type === undefined ? {} : { type: q.type as TripRow['type'] }),
          ...(q.vehicleId === undefined ? {} : { vehicleId: q.vehicleId }),
          ...(q.q === undefined ? {} : { tripNo: { contains: q.q.toUpperCase() } }),
          ...(q.cursor === undefined ? {} : { id: { lt: q.cursor } }),
        },
        include: TRIP,
        orderBy: { id: 'desc' },
        take: q.limit + 1,
        ...(q.offset === null ? {} : { skip: q.offset }),
      }),
    );
  }

  countTrips(scope: WarehouseScope, q: { warehouseId?: string; status?: string; type?: string }) {
    return withPrismaErrors(() =>
      this.db.wmsTrip.count({
        where: {
          ...scoped(scope, q.warehouseId),
          ...(q.status === undefined ? {} : { status: q.status as TripRow['status'] }),
          ...(q.type === undefined ? {} : { type: q.type as TripRow['type'] }),
        },
        take: 10_001,
      }),
    );
  }

  /** Trips (not cancelled) carrying some shipments. */
  tripsOfShipments(shipmentIds: readonly string[]) {
    if (shipmentIds.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsTrip.findMany({
        where: {
          status: { not: 'CANCELLED' },
          shipments: { some: { shipmentId: { in: [...new Set(shipmentIds)] } } },
        },
        include: TRIP,
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  activeTripOf(tx: Tx, kind: 'vehicle' | 'driver', id: string, exceptTripId?: string) {
    return tx.wmsTrip.findFirst({
      where: {
        ...(kind === 'vehicle' ? { vehicleId: id } : { driverId: id }),
        status: { in: ['PLANNED', 'LOADING', 'DEPARTED'] },
        ...(exceptTripId === undefined ? {} : { id: { not: exceptTripId } }),
      },
      select: { id: true, tripNo: true },
    });
  }

  recentWeighings(scope: WarehouseScope, warehouseId: string | undefined, limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsTrip.findMany({
        where: { ...scoped(scope, warehouseId), weighedAt: { not: null } },
        orderBy: { weighedAt: 'desc' },
        take: limit,
        include: TRIP,
      }),
    );
  }

  async tripCounts(scope: WarehouseScope, warehouseId?: string) {
    const rows = await withPrismaErrors(() =>
      this.db.wmsTrip.groupBy({
        by: ['status', 'type'],
        where: scoped(scope, warehouseId),
        _count: { _all: true },
      }),
    );
    return rows.map((r) => ({ status: r.status, type: r.type, n: r._count._all }));
  }

  async avgTurnaroundMin(scope: WarehouseScope, warehouseId: string | undefined, since: Date) {
    const [r] = await this.db.$queryRaw<{ m: number | null }[]>`
      SELECT avg(EXTRACT(EPOCH FROM ("departedAt" - COALESCE("gateInAt", "loadingStartedAt"))) / 60)::float8 AS m
      FROM "warehouse_dispatch_trips"
      WHERE "departedAt" >= ${since} AND COALESCE("gateInAt", "loadingStartedAt") IS NOT NULL
        ${warehouseId !== undefined ? Prisma.sql`AND "warehouseId" = ${warehouseId}::uuid` : scope === 'ALL' ? Prisma.empty : Prisma.sql`AND "warehouseId" = ANY(${[...scope]}::uuid[])`}`;
    return r?.m == null ? null : Math.round(r.m);
  }

  // ── 3PL driver links (§2a.8) ──

  createLink(
    tx: Tx,
    data: { tripId: string; tokenHash: string; phone: string; expiresAt: Date; createdBy: string },
  ) {
    return tx.wmsDriverLink.create({ data });
  }

  linkByHash(tokenHash: string) {
    return withPrismaErrors(() => this.db.wmsDriverLink.findUnique({ where: { tokenHash } }));
  }

  activeLinks(tripId: string) {
    return withPrismaErrors(() =>
      this.db.wmsDriverLink.findMany({
        where: { tripId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async revokeLinks(tx: Tx, tripId: string) {
    return tx.wmsDriverLink.updateMany({
      where: { tripId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async expireLinks(tx: Tx, tripId: string, at: Date) {
    await tx.wmsDriverLink.updateMany({
      where: { tripId, revokedAt: null, expiresAt: { gt: at } },
      data: { expiresAt: at },
    });
  }

  async touchLink(id: string) {
    await this.db.wmsDriverLink.update({
      where: { id },
      data: { lastUsedAt: new Date() },
      select: { id: true },
    });
  }

  // ── pings (partitioned) ──

  async lastPingAt(tx: Tx, tripId: string): Promise<Date | null> {
    const [r] = await tx.$queryRaw<{ at: Date }[]>`
      SELECT "at" FROM "warehouse_dispatch_trip_pings" WHERE "tripId" = ${tripId}::uuid ORDER BY "at" DESC LIMIT 1`;
    return r?.at ?? null;
  }

  async addPing(
    tx: Tx,
    p: {
      tripId: string;
      at: Date;
      lat: number;
      lng: number;
      speedKmh: number | null;
      remainingKm: number | null;
      network: string | null;
      source: string;
    },
  ) {
    await tx.$executeRaw`INSERT INTO "warehouse_dispatch_trip_pings" ("tripId", "at", "lat", "lng", "speedKmh", "remainingKm", "network", "source")
      VALUES (${p.tripId}::uuid, ${p.at}, ${p.lat}, ${p.lng}, ${p.speedKmh}, ${p.remainingKm}, ${p.network}, ${p.source})
      ON CONFLICT DO NOTHING`;
  }

  pings(tripId: string, since: Date, limit: number) {
    return this.db.$queryRaw<
      { at: Date; lat: string; lng: string; speedKmh: string | null; remainingKm: string | null }[]
    >`
      SELECT "at", "lat"::text, "lng"::text, "speedKmh"::text, "remainingKm"::text FROM "warehouse_dispatch_trip_pings"
      WHERE "tripId" = ${tripId}::uuid AND "at" >= ${since} ORDER BY "at" DESC LIMIT ${limit}`;
  }

  /** ping-retention: next months' partitions exist; partitions older than 90 days dropped. */
  async maintainPingPartitions(): Promise<{ created: string[]; dropped: string[] }> {
    const created: string[] = [];
    const dropped: string[] = [];
    const now = new Date();
    for (let i = 0; i <= 2; i += 1) {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 1));
      const name = `warehouse_dispatch_trip_pings_${from.toISOString().slice(0, 7).replace('-', '')}`;
      const exists = await this.db.$queryRaw<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM pg_class WHERE relname = ${name}`;
      if ((exists[0]?.n ?? 0) > 0) continue;
      // A row already in the default partition for that month blocks the new partition: move it.
      await this.db.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "warehouse_dispatch_trip_pings" FOR VALUES FROM ('${from.toISOString()}') TO ('${to.toISOString()}')`,
      );
      created.push(name);
    }
    const old = await this.db.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'warehouse_dispatch_trip_pings' AND c.relname ~ '^warehouse_dispatch_trip_pings_[0-9]{6}$'`;
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const cutoffKey = Number(
      `${String(cutoff.getUTCFullYear())}${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`,
    );
    for (const o of old) {
      const key = Number(o.name.slice(-6));
      if (key < cutoffKey) {
        await this.db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${o.name}"`);
        dropped.push(o.name);
      }
    }
    await this.db.$executeRaw`DELETE FROM "warehouse_dispatch_trip_pings" WHERE "at" < ${cutoff}`;
    return { created, dropped };
  }

  /** ping-downsample: pings older than 7 days → first per 5-minute bucket per trip. */
  async downsamplePings(): Promise<number> {
    return this.db.$executeRaw`
      DELETE FROM "warehouse_dispatch_trip_pings" p
      USING (
        SELECT "tripId", "at", row_number() OVER (PARTITION BY "tripId", date_trunc('hour', "at"), floor(EXTRACT(MINUTE FROM "at") / 5) ORDER BY "at") AS rn
        FROM "warehouse_dispatch_trip_pings"
        WHERE "at" < now() - interval '7 days' AND "at" >= now() - interval '8 days'
      ) d
      WHERE p."tripId" = d."tripId" AND p."at" = d."at" AND d.rn > 1`;
  }
}
