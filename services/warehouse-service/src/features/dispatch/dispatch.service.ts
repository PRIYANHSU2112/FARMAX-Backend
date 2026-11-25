import {
  AppError,
  ErrorCode,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import { createHash, randomBytes } from 'node:crypto';

import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { type Paging, csvCell, offsetOf, toPageResult } from '../../middleware/paging.js';
import type {
  CarrierRow,
  DriverRow,
  JsonInput,
  RouteRow,
  TripRow,
  VehicleRow,
} from './dispatch.repository.js';

interface Stop {
  name: string;
  lat: number | null;
  lng: number | null;
  shipmentId?: string | null;
}
const num = (d: { toString(): string } | null | undefined) =>
  d === null || d === undefined ? null : Number(d.toString());
const km = (
  a: { lat: number | null; lng: number | null },
  b: { lat: number | null; lng: number | null },
) => {
  if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return null;
  const r = (x: number) => (x * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(h)) * 10) / 10;
};
/** The update fields without the optimistic-lock version. */
const omitVersion = <T extends { expectedVersion: number }>(i: T): Omit<T, 'expectedVersion'> => {
  const out: Partial<T> = { ...i };
  delete out.expectedVersion;
  return out as Omit<T, 'expectedVersion'>;
};
const ACTIVE_TRIP: readonly TripRow['status'][] = ['PLANNED', 'LOADING', 'DEPARTED'];

/**
 * Dispatch (D-57b Phase 4a, own module §2a.9): route master, carriers, vehicles, drivers and
 * trips (many shipments ↔ many trips). Depart = gate-out: every shipment READY_TO_DISPATCH →
 * DISPATCHED through fulfilment (stock issued once via shipment.dispatched.v1). Pings by API
 * (≤ 1 stored per 30 s per trip), manual weighbridge with a tolerance check.
 */
export class DispatchService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'dispatchRepository'
      | 'fulfilmentFloor'
      | 'fulfilmentQueries'
      | 'fulfilmentSettings'
      | 'warehousesService'
      | 'docksService'
      | 'stockService'
      | 'mediaClient'
      | 'config'
      | 'runInTransaction'
      | 'auditService'
    >,
  ) {}

  private get repo() {
    return this.deps.dispatchRepository;
  }

  // ── route master ──

  async routes(caller: Caller, q: { warehouseId?: string; active?: boolean; q?: string }) {
    const rows = await this.repo.routes(this.scope(caller, q.warehouseId), q);
    return rows.map((r) => this.routeView(r));
  }

  async createRoute(
    caller: Caller,
    input: {
      warehouseId: string;
      code: string;
      name: string;
      corridorName?: string | null;
      pinCodes: string[];
      districts?: string[];
      stops?: Stop[];
    },
  ) {
    await this.deps.warehousesService.requireVisible(
      caller,
      input.warehouseId,
      'logistics.fleet_manage',
    );
    return this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.createRoute(tx, {
        warehouseId: input.warehouseId,
        code: input.code.toUpperCase(),
        name: input.name,
        corridorName: input.corridorName ?? null,
        pinCodes: [...new Set(input.pinCodes)],
        districts: input.districts ?? [],
        stops: (input.stops ?? []) as unknown as JsonInput,
        createdBy: caller.userId,
      });
      await this.audit(tx, caller, 'dispatch.route_created', r.id, { code: r.code });
      return this.routeView(r);
    });
  }

  async updateRoute(
    caller: Caller,
    id: string,
    input: Partial<{
      name: string;
      corridorName: string | null;
      pinCodes: string[];
      districts: string[];
      stops: Stop[];
      isActive: boolean;
    }> & { expectedVersion: number },
  ) {
    const cur = await this.repo.route(id);
    if (cur === null) throw new NotFoundError('Route');
    caller.access.require('logistics.fleet_manage', cur.warehouseId);
    if (cur.version !== input.expectedVersion)
      throw new ConflictError('The route changed', { details: { reason: 'VERSION_CONFLICT' } });
    const { stops, ...rest } = omitVersion(input);
    return this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.updateRoute(tx, id, {
        ...rest,
        ...(rest.pinCodes === undefined ? {} : { pinCodes: [...new Set(rest.pinCodes)] }),
        ...(stops === undefined ? {} : { stops: stops as unknown as JsonInput }),
        updatedBy: caller.userId,
      });
      await this.audit(tx, caller, 'dispatch.route_updated', id, input);
      return this.routeView(r);
    });
  }

  /** Route of a delivery PIN at a warehouse (fulfilment sets it on release). */
  async routeForPin(warehouseId: string, pinCode: string | null, tx?: Tx): Promise<string | null> {
    if (pinCode === null) return null;
    return (await this.repo.routeForPin(warehouseId, pinCode, tx))?.id ?? null;
  }

  // ── carriers / vehicles / drivers ──

  carriers(q: { type?: string; status?: string; q?: string }) {
    return this.repo.carriers(q);
  }

  async createCarrier(
    caller: Caller,
    input: { name: string; type: CarrierRow['type']; phone?: string | null; gstin?: string | null },
  ) {
    this.requireAnywhere(caller, 'logistics.fleet_manage');
    return this.deps.runInTransaction(async (tx) => {
      const c = await this.repo.createCarrier(tx, {
        ...input,
        phone: input.phone ?? null,
        gstin: input.gstin ?? null,
        createdBy: caller.userId,
      });
      await this.audit(tx, caller, 'dispatch.carrier_created', c.id, { name: c.name });
      return c;
    });
  }

  async updateCarrier(
    caller: Caller,
    id: string,
    input: Partial<{
      name: string;
      phone: string | null;
      gstin: string | null;
      status: CarrierRow['status'];
    }> & { expectedVersion: number },
  ) {
    this.requireAnywhere(caller, 'logistics.fleet_manage');
    const cur = await this.repo.carrier(id);
    if (cur === null) throw new NotFoundError('Carrier');
    if (cur.version !== input.expectedVersion)
      throw new ConflictError('The carrier changed', { details: { reason: 'VERSION_CONFLICT' } });
    const data = omitVersion(input);
    return this.deps.runInTransaction(async (tx) => {
      const c = await this.repo.updateCarrier(tx, id, data);
      await this.audit(tx, caller, 'dispatch.carrier_updated', id, data);
      return c;
    });
  }

  async vehicles(
    caller: Caller,
    q: {
      warehouseId?: string;
      status?: string;
      carrierId?: string;
      q?: string;
      available?: boolean;
    },
  ) {
    const rows = await this.repo.vehicles(this.scope(caller, q.warehouseId), q);
    const busy = new Set<string>();
    if (q.available === true)
      await this.deps.runInTransaction(async (tx) => {
        for (const v of rows)
          if ((await this.repo.activeTripOf(tx, 'vehicle', v.id)) !== null) busy.add(v.id);
      });
    return rows
      .filter((v) => !busy.has(v.id) && (q.available !== true || v.status === 'ACTIVE'))
      .map((v) => this.vehicleView(v));
  }

  async createVehicle(
    caller: Caller,
    input: {
      regNo: string;
      carrierId?: string | null;
      warehouseId?: string | null;
      vehicleClass: VehicleRow['vehicleClass'];
      capacityKg: number;
      refrigerated?: boolean;
      sensorsEnabled?: boolean;
    },
  ) {
    if (input.warehouseId != null)
      caller.access.require('logistics.fleet_manage', input.warehouseId);
    else this.requireAnywhere(caller, 'logistics.fleet_manage');
    const regNo = input.regNo.replace(/\s+/g, '').toUpperCase();
    return this.deps.runInTransaction(async (tx) => {
      if ((await this.repo.vehicleByReg(regNo, tx)) !== null)
        throw new ConflictError(`Vehicle ${regNo} already exists`, {
          details: { reason: 'DUPLICATE_REG_NO' },
        });
      const v = await this.repo.createVehicle(tx, {
        regNo,
        carrierId: input.carrierId ?? null,
        warehouseId: input.warehouseId ?? null,
        vehicleClass: input.vehicleClass,
        capacityKg: input.capacityKg.toFixed(2),
        refrigerated: input.refrigerated ?? false,
        sensorsEnabled: input.sensorsEnabled ?? false,
        createdBy: caller.userId,
      });
      await this.audit(tx, caller, 'dispatch.vehicle_created', v.id, { regNo });
      return this.vehicleView(v);
    });
  }

  async updateVehicle(
    caller: Caller,
    id: string,
    input: Partial<{
      carrierId: string | null;
      warehouseId: string | null;
      vehicleClass: VehicleRow['vehicleClass'];
      capacityKg: number;
      refrigerated: boolean;
      sensorsEnabled: boolean;
      status: VehicleRow['status'];
    }> & { expectedVersion: number },
  ) {
    const cur = await this.repo.vehicle(id);
    if (cur === null) throw new NotFoundError('Vehicle');
    if (cur.warehouseId !== null) caller.access.require('logistics.fleet_manage', cur.warehouseId);
    else this.requireAnywhere(caller, 'logistics.fleet_manage');
    if (cur.version !== input.expectedVersion)
      throw new ConflictError('The vehicle changed', { details: { reason: 'VERSION_CONFLICT' } });
    const { capacityKg, ...rest } = omitVersion(input);
    return this.deps.runInTransaction(async (tx) => {
      const v = await this.repo.updateVehicle(tx, id, {
        ...rest,
        ...(capacityKg === undefined ? {} : { capacityKg: capacityKg.toFixed(2) }),
      });
      await this.audit(tx, caller, 'dispatch.vehicle_updated', id, input);
      return this.vehicleView(v);
    });
  }

  async drivers(
    caller: Caller,
    q: { warehouseId?: string; status?: string; carrierId?: string; q?: string },
  ) {
    const rows = await this.repo.drivers(this.scope(caller, q.warehouseId), q);
    return rows.map((d) => this.driverView(d));
  }

  async createDriver(
    caller: Caller,
    input: {
      name: string;
      phone: string;
      userId?: string | null;
      licenceNo?: string | null;
      kycStatus?: DriverRow['kycStatus'];
      carrierId?: string | null;
      warehouseId?: string | null;
    },
  ) {
    if (input.warehouseId != null)
      caller.access.require('logistics.fleet_manage', input.warehouseId);
    else this.requireAnywhere(caller, 'logistics.fleet_manage');
    return this.deps.runInTransaction(async (tx) => {
      const d = await this.repo.createDriver(tx, {
        name: input.name,
        phone: input.phone,
        userId: input.userId ?? null,
        licenceNo: input.licenceNo ?? null,
        kycStatus: input.kycStatus ?? 'PENDING',
        carrierId: input.carrierId ?? null,
        warehouseId: input.warehouseId ?? null,
        createdBy: caller.userId,
      });
      await this.audit(tx, caller, 'dispatch.driver_created', d.id, { name: d.name });
      return this.driverView(d);
    });
  }

  async updateDriver(
    caller: Caller,
    id: string,
    input: Partial<{
      name: string;
      phone: string;
      userId: string | null;
      licenceNo: string | null;
      kycStatus: DriverRow['kycStatus'];
      carrierId: string | null;
      warehouseId: string | null;
      status: DriverRow['status'];
    }> & { expectedVersion: number },
  ) {
    const cur = await this.repo.driver(id);
    if (cur === null) throw new NotFoundError('Driver');
    if (cur.warehouseId !== null) caller.access.require('logistics.fleet_manage', cur.warehouseId);
    else this.requireAnywhere(caller, 'logistics.fleet_manage');
    if (cur.version !== input.expectedVersion)
      throw new ConflictError('The driver changed', { details: { reason: 'VERSION_CONFLICT' } });
    const data = omitVersion(input);
    return this.deps.runInTransaction(async (tx) => {
      const d = await this.repo.updateDriver(tx, id, data);
      await this.audit(tx, caller, 'dispatch.driver_updated', id, data);
      return this.driverView(d);
    });
  }

  // ── trips ──

  async createTrip(
    caller: Caller,
    input: {
      warehouseId: string;
      shipmentIds: string[];
      type?: TripRow['type'];
      vehicleId?: string | null;
      driverId?: string | null;
      carrierId?: string | null;
      routeId?: string | null;
      dockDoorId?: string | null;
      dockBookingId?: string | null;
      routeStops?: Stop[];
      plannedDepartAt?: string | null;
      etaAt?: string | null;
      note?: string | null;
    },
  ) {
    await this.deps.warehousesService.requireVisible(
      caller,
      input.warehouseId,
      'logistics.dispatch_assign',
    );
    const facts = await this.deps.fulfilmentQueries.shipmentFacts(input.shipmentIds);
    this.checkShipments(input.warehouseId, input.shipmentIds, facts, [
      'ALLOCATED',
      'ASSIGNED',
      'PICKING',
      'PACKING',
      'QC',
      'READY_TO_DISPATCH',
    ]);
    const id = await this.deps.runInTransaction(async (tx) => {
      await this.assertFree(tx, input.vehicleId ?? null, input.driverId ?? null);
      const vehicle = input.vehicleId == null ? null : await this.repo.vehicle(input.vehicleId, tx);
      if (input.vehicleId != null && vehicle === null) throw new NotFoundError('Vehicle');
      const totalKg = facts.reduce((n, f) => n + f.weightKg, 0);
      if (vehicle !== null && totalKg > Number(vehicle.capacityKg.toString()))
        throw new ValidationError([
          {
            path: 'body.shipmentIds',
            message: `${String(totalKg)} kg is over the vehicle capacity ${vehicle.capacityKg.toString()} kg`,
          },
        ]);
      const routeId = input.routeId ?? facts.find((f) => f.routeId !== null)?.routeId ?? null;
      const named = routeId === null ? null : await this.repo.route(routeId, tx);
      const namedStops = (named?.stops ?? []) as unknown as Stop[];
      // Named route path first (W3.08); else one stop per drop.
      const stops: Stop[] =
        input.routeStops ??
        (namedStops.length > 0 ? namedStops : null) ??
        facts.map((f) => ({
          name: f.destination.formatted ?? f.destination.district ?? f.shipmentNo,
          lat: f.destination.lat,
          lng: f.destination.lng,
          shipmentId: f.id,
        }));
      const t = await this.repo.createTrip(
        tx,
        {
          tripNo: await this.deps.stockService.nextDocNo(tx, 'TRP'),
          warehouseId: input.warehouseId,
          type: input.type ?? (facts.some((f) => f.isBulk) ? 'BULK' : 'STANDARD'),
          vehicleId: input.vehicleId ?? null,
          driverId: input.driverId ?? null,
          carrierId: input.carrierId ?? vehicle?.carrierId ?? null,
          routeId,
          dockDoorId: input.dockDoorId ?? null,
          dockBookingId: input.dockBookingId ?? null,
          routeStops: stops as unknown as JsonInput,
          plannedDepartAt: input.plannedDepartAt == null ? null : new Date(input.plannedDepartAt),
          etaAt: input.etaAt == null ? null : new Date(input.etaAt),
          note: input.note ?? null,
          createdBy: caller.userId,
        },
        facts.map((f, i) => ({ shipmentId: f.id, seq: i + 1, plannedKg: f.weightKg.toFixed(2) })),
      );
      await this.audit(tx, caller, 'dispatch.trip_created', t.id, {
        tripNo: t.tripNo,
        shipments: input.shipmentIds,
      });
      return t.id;
    });
    return this.trip(caller, id);
  }

  async trips(
    caller: Caller,
    q: { warehouseId?: string; status?: string; type?: string; vehicleId?: string; q?: string },
    p: Paging,
  ) {
    const scope = this.scope(caller, q.warehouseId);
    const offset = offsetOf(p);
    const [rows, total] = await Promise.all([
      this.repo.trips(scope, {
        ...q,
        ...(p.cursor === undefined ? {} : { cursor: p.cursor }),
        limit: p.limit,
        offset,
      }),
      offset === null ? Promise.resolve(undefined) : this.repo.countTrips(scope, q),
    ]);
    const page = toPageResult(
      rows,
      { limit: p.limit, ...(p.page === undefined ? {} : { page: p.page }) },
      (t) => [t.id],
      total,
    );
    const views = await this.tripViews(page.items);
    return {
      ...page,
      nextCursor: offset === null && rows.length > p.limit ? (page.items.at(-1)?.id ?? null) : null,
      items: views,
    };
  }

  async trip(caller: Caller, id: string) {
    const t = await this.visibleTrip(caller, id);
    const [view] = await this.tripViews([t]);
    const shipments = await this.deps.fulfilmentQueries.shipmentFacts(
      t.shipments.map((s) => s.shipmentId),
    );
    return {
      ...view,
      routeStops: t.routeStops,
      note: t.note,
      shipments: t.shipments.map((ts) => ({
        ...ts,
        plannedKg: num(ts.plannedKg),
        loadedKg: num(ts.loadedKg),
        shipment: shipments.find((s) => s.id === ts.shipmentId) ?? null,
      })),
    };
  }

  async addShipments(caller: Caller, id: string, shipmentIds: string[]) {
    await this.deps.runInTransaction(async (tx) => {
      const t = await this.lockTrip(tx, caller, id);
      if (t.status !== 'PLANNED' && t.status !== 'LOADING')
        throw new ConflictError('The trip has left', { details: { reason: 'TRIP_LOCKED' } });
      const facts = await this.deps.fulfilmentQueries.shipmentFacts(shipmentIds);
      this.checkShipments(t.warehouseId, shipmentIds, facts, [
        'ALLOCATED',
        'ASSIGNED',
        'PICKING',
        'PACKING',
        'QC',
        'READY_TO_DISPATCH',
      ]);
      await this.repo.addTripShipments(
        tx,
        id,
        facts.map((f, i) => ({
          shipmentId: f.id,
          seq: t.shipments.length + i + 1,
          plannedKg: f.weightKg.toFixed(2),
        })),
      );
      await this.audit(tx, caller, 'dispatch.trip_shipments_added', id, { shipmentIds });
    });
    return this.trip(caller, id);
  }

  async removeShipment(caller: Caller, id: string, shipmentId: string) {
    await this.deps.runInTransaction(async (tx) => {
      const t = await this.lockTrip(tx, caller, id);
      if (t.status !== 'PLANNED' && t.status !== 'LOADING')
        throw new ConflictError('The trip has left', { details: { reason: 'TRIP_LOCKED' } });
      if (!t.shipments.some((s) => s.shipmentId === shipmentId))
        throw new NotFoundError('Trip shipment');
      await this.repo.removeTripShipment(tx, id, shipmentId);
      await this.audit(tx, caller, 'dispatch.trip_shipment_removed', id, { shipmentId });
    });
    return this.trip(caller, id);
  }

  /** Gate-in / loading progress (W3.19 Loading). */
  async loading(
    caller: Caller,
    id: string,
    input: {
      gateIn?: boolean;
      loadedPct?: number;
      shipments?: { shipmentId: string; loadedKg: number }[];
    },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const t = await this.lockTrip(tx, caller, id);
      if (t.status !== 'PLANNED' && t.status !== 'LOADING')
        throw new ConflictError('The trip has left', { details: { reason: 'TRIP_LOCKED' } });
      for (const s of input.shipments ?? []) {
        if (!t.shipments.some((x) => x.shipmentId === s.shipmentId))
          throw new ValidationError([
            { path: 'body.shipments', message: 'shipment is not on this trip' },
          ]);
        await this.repo.setLoadedKg(tx, id, s.shipmentId, s.loadedKg.toFixed(2));
      }
      await this.repo.updateTrip(tx, id, {
        status: 'LOADING',
        ...(t.loadingStartedAt === null ? { loadingStartedAt: new Date() } : {}),
        ...(input.gateIn === true && t.gateInAt === null ? { gateInAt: new Date() } : {}),
        ...(input.loadedPct === undefined ? {} : { loadedPct: input.loadedPct }),
      });
    });
    return this.trip(caller, id);
  }

  /** Manual weighbridge: gross − tare = net, verified within tolerance of the planned payload. */
  async weighbridge(
    caller: Caller,
    id: string,
    input: { grossKg: number; tareKg: number; slipNo?: string | null; receipt?: string | null },
  ) {
    if (input.tareKg >= input.grossKg)
      throw new ValidationError([
        { path: 'body.tareKg', message: 'must be below the gross weight' },
      ]);
    const slip =
      input.receipt == null
        ? null
        : this.deps.mediaClient.verify(input.receipt, caller.userId, 'body.receipt', 'wms_document')
            .key;
    await this.deps.runInTransaction(async (tx) => {
      const t = await this.lockTrip(tx, caller, id);
      if (t.status === 'CANCELLED' || t.status === 'COMPLETED')
        throw new ConflictError('The trip is closed', { details: { reason: 'TRIP_LOCKED' } });
      const net = input.grossKg - input.tareKg;
      const planned = t.shipments.reduce(
        (n, s) => n + (num(s.loadedKg) ?? num(s.plannedKg) ?? 0),
        0,
      );
      const tol = await this.deps.fulfilmentSettings.get(
        'fulfilment.weighTolerancePct',
        t.warehouseId,
      );
      await this.repo.updateTrip(tx, id, {
        grossKg: input.grossKg.toFixed(2),
        tareKg: input.tareKg.toFixed(2),
        netKg: net.toFixed(2),
        weighSlipNo: input.slipNo ?? null,
        ...(slip === null ? {} : { weighSlipMediaKey: slip }),
        weighedAt: new Date(),
        weightVerified: planned === 0 ? null : Math.abs(net - planned) <= (planned * tol) / 100,
      });
      await this.audit(tx, caller, 'dispatch.weighbridge', id, {
        grossKg: input.grossKg,
        tareKg: input.tareKg,
        netKg: net,
        plannedKg: planned,
      });
    });
    return this.weighbridgeView(caller, id);
  }

  async weighbridgeView(caller: Caller, id: string) {
    const t = await this.visibleTrip(caller, id);
    const planned = t.shipments.reduce((n, s) => n + (num(s.loadedKg) ?? num(s.plannedKg) ?? 0), 0);
    const urls =
      t.weighSlipMediaKey === null
        ? {}
        : await this.deps.mediaClient.signRead([t.weighSlipMediaKey]);
    return {
      tripId: t.id,
      tripNo: t.tripNo,
      grossKg: num(t.grossKg),
      tareKg: num(t.tareKg),
      netKg: num(t.netKg),
      plannedKg: planned,
      weightVerified: t.weightVerified,
      label:
        t.netKg === null
          ? null
          : `Net: ${(Number(t.netKg.toString()) / 1000).toFixed(2)} T${t.weightVerified === true ? ' Verified' : t.weightVerified === false ? ' Mismatch' : ''}`,
      slipNo: t.weighSlipNo,
      slipUrl: t.weighSlipMediaKey === null ? null : (urls[t.weighSlipMediaKey] ?? null),
      weighedAt: t.weighedAt,
      modules: { liveWeighbridge: false },
    };
  }

  async recentWeighings(caller: Caller, warehouseId: string | undefined, limit: number) {
    const rows = await this.repo.recentWeighings(
      this.scope(caller, warehouseId),
      warehouseId,
      limit,
    );
    return rows.map((t) => ({
      tripId: t.id,
      tripNo: t.tripNo,
      netKg: num(t.netKg),
      grossKg: num(t.grossKg),
      tareKg: num(t.tareKg),
      weightVerified: t.weightVerified,
      weighedAt: t.weighedAt,
    }));
  }

  /**
   * Gate-out: every shipment must be READY_TO_DISPATCH (not on hold) → DISPATCHED.
   * D-61 saga: (1) access + state checked, then each shipment's GST invoice is issued (or
   * replayed) at order-service OUTSIDE the transaction; (2) the transaction dispatches and
   * re-checks every shipment's lines hash under its row lock. A failure before (2) leaves the
   * trip as it was; departing again replays the same invoices (idempotent).
   */
  async depart(caller: Caller, id: string, input: { etaAt?: string | null; note?: string | null }) {
    const pre = await this.repo.trip(id);
    if (pre === null) throw new NotFoundError('Trip');
    caller.access.require('logistics.dispatch_assign', pre.warehouseId);
    if (pre.status !== 'PLANNED' && pre.status !== 'LOADING')
      throw new ConflictError(`The trip is ${pre.status}`, { details: { reason: 'TRIP_LOCKED' } });
    if (pre.vehicleId === null || pre.driverId === null)
      throw new ConflictError('Assign a vehicle and a driver before departure', {
        details: { reason: 'VEHICLE_OR_DRIVER_MISSING' },
      });
    const invoices = await this.deps.fulfilmentFloor.prepareInvoices(
      pre.shipments.map((s) => s.shipmentId),
      caller.userId,
    );
    await this.deps.runInTransaction(async (tx) => {
      const t = await this.lockTrip(tx, caller, id);
      if (t.status !== 'PLANNED' && t.status !== 'LOADING')
        throw new ConflictError(`The trip is ${t.status}`, { details: { reason: 'TRIP_LOCKED' } });
      if (t.vehicleId === null || t.driverId === null)
        throw new ConflictError('Assign a vehicle and a driver before departure', {
          details: { reason: 'VEHICLE_OR_DRIVER_MISSING' },
        });
      if (t.shipments.length === 0)
        throw new ConflictError('The trip has no shipments', { details: { reason: 'EMPTY_TRIP' } });
      const actor = {
        type: 'STAFF' as const,
        id: caller.userId,
        requestId: caller.requestId,
        access: caller.access,
      };
      const dispatched = [];
      for (const s of t.shipments)
        dispatched.push({
          ...(await this.deps.fulfilmentFloor.dispatchInTx(
            tx,
            s.shipmentId,
            actor,
            `Trip ${t.tripNo}`,
            invoices.get(s.shipmentId),
          )),
          invoiceNo: invoices.get(s.shipmentId)?.invoice?.docNo ?? null,
        });
      await this.repo.updateTrip(tx, id, {
        status: 'DEPARTED',
        departedAt: new Date(),
        loadedPct: 100,
        ...(input.etaAt == null ? {} : { etaAt: new Date(input.etaAt) }),
      });
      await this.audit(tx, caller, 'dispatch.trip_departed', id, {
        tripNo: t.tripNo,
        shipments: dispatched,
      });
    });
    return {
      ...(await this.trip(caller, id)),
      invoices: [...invoices.values()].map((g) => ({
        shipmentId: g.shipmentId,
        shipmentNo: g.shipmentNo,
        invoiceNo: g.invoice?.docNo ?? null,
        docType: g.invoice?.docType ?? null,
        grandTotal: g.invoice?.grandTotal ?? null,
        replacedInvoiceNo: g.invoice?.voidedDocNo ?? null,
        ewayBillRequired: g.ewayBillRequired,
      })),
    };
  }

  async complete(caller: Caller, id: string) {
    await this.deps.runInTransaction(async (tx) => {
      const t = await this.lockTrip(tx, caller, id);
      if (t.status !== 'DEPARTED')
        throw new ConflictError('Only a departed trip can be completed', {
          details: { reason: 'INVALID_STATE' },
        });
      await this.repo.updateTrip(tx, id, { status: 'COMPLETED', completedAt: new Date() });
      // 3PL links stay usable 12 h after completion (late POD), then expire.
      await this.repo.expireLinks(tx, id, new Date(Date.now() + 12 * 3_600_000));
      await this.audit(tx, caller, 'dispatch.trip_completed', id, {});
    });
    return this.trip(caller, id);
  }

  async cancel(caller: Caller, id: string, reason: string) {
    await this.deps.runInTransaction(async (tx) => {
      const t = await this.lockTrip(tx, caller, id);
      if (t.status !== 'PLANNED' && t.status !== 'LOADING')
        throw new ConflictError('A departed trip cannot be cancelled', {
          details: { reason: 'TRIP_LOCKED' },
        });
      await this.repo.updateTrip(tx, id, {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        note: reason,
      });
      await this.audit(tx, caller, 'dispatch.trip_cancelled', id, {}, reason);
    });
    return this.trip(caller, id);
  }

  /** W3.08 Reassign: another vehicle and / or driver (audited, reason). */
  async reassign(
    caller: Caller,
    id: string,
    input: { vehicleId?: string; driverId?: string; reason: string },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const t = await this.lockTrip(tx, caller, id);
      if (!ACTIVE_TRIP.includes(t.status))
        throw new ConflictError('The trip is closed', { details: { reason: 'TRIP_LOCKED' } });
      await this.assertFree(tx, input.vehicleId ?? null, input.driverId ?? null, id);
      if (input.vehicleId !== undefined && (await this.repo.vehicle(input.vehicleId, tx)) === null)
        throw new NotFoundError('Vehicle');
      if (input.driverId !== undefined && (await this.repo.driver(input.driverId, tx)) === null)
        throw new NotFoundError('Driver');
      await this.repo.updateTrip(tx, id, {
        ...(input.vehicleId === undefined ? {} : { vehicleId: input.vehicleId }),
        ...(input.driverId === undefined ? {} : { driverId: input.driverId }),
      });
      await this.audit(
        tx,
        caller,
        'dispatch.trip_reassigned',
        id,
        { from: { vehicleId: t.vehicleId, driverId: t.driverId }, to: input },
        input.reason,
      );
    });
    return this.trip(caller, id);
  }

  /** Tracking ping (staff / driver app; 3PL links in Phase 4b). ≤ 1 stored per interval per trip. */
  async ping(
    caller: Caller | null,
    id: string,
    p: {
      lat: number;
      lng: number;
      speedKmh?: number | null;
      remainingKm?: number | null;
      network?: string | null;
      at?: string | null;
    },
    source = 'STAFF',
  ) {
    return this.deps.runInTransaction(async (tx) => {
      const t =
        caller === null
          ? await this.repo.lockTrip(tx, id)
          : await this.lockTrip(tx, caller, id, 'logistics.consignment_view');
      if (t === null) throw new NotFoundError('Trip');
      if (t.status !== 'DEPARTED' && t.status !== 'LOADING')
        throw new ConflictError('Pings are taken while the trip runs', {
          details: { reason: 'INVALID_STATE' },
        });
      const at = p.at == null ? new Date() : new Date(p.at);
      const minSec = await this.deps.fulfilmentSettings.get(
        'fulfilment.pingMinIntervalSec',
        t.warehouseId,
      );
      const last = await this.repo.lastPingAt(tx, id);
      const stored = last === null || at.getTime() - last.getTime() >= minSec * 1000;
      if (stored)
        await this.repo.addPing(tx, {
          tripId: id,
          at,
          lat: p.lat,
          lng: p.lng,
          speedKmh: p.speedKmh ?? null,
          remainingKm: p.remainingKm ?? null,
          network: p.network ?? null,
          source,
        });
      await this.repo.updateTrip(tx, id, {
        lastPingAt: at,
        lastLat: p.lat.toFixed(6),
        lastLng: p.lng.toFixed(6),
        lastSpeedKmh: p.speedKmh == null ? null : p.speedKmh.toFixed(1),
        remainingKm: p.remainingKm == null ? null : p.remainingKm.toFixed(1),
        network: p.network ?? null,
      });
      return { stored, at };
    });
  }

  async route(caller: Caller, id: string) {
    const t = await this.visibleTrip(caller, id);
    const r = t.routeId === null ? null : await this.repo.route(t.routeId);
    const stops =
      (t.routeStops as unknown as Stop[]).length > 0
        ? (t.routeStops as unknown as Stop[])
        : ((r?.stops ?? []) as unknown as Stop[]);
    const pings = await this.repo.pings(id, new Date(Date.now() - 24 * 3_600_000), 500);
    return {
      tripId: t.id,
      route:
        r === null ? null : { id: r.id, code: r.code, name: r.name, corridorName: r.corridorName },
      stops: this.progress(stops, { lat: num(t.lastLat), lng: num(t.lastLng) }),
      breadcrumb: pings.reverse().map((x) => ({
        at: x.at,
        lat: Number(x.lat),
        lng: Number(x.lng),
        speedKmh: x.speedKmh === null ? null : Number(x.speedKmh),
      })),
    };
  }

  async tracking(caller: Caller, id: string) {
    const t = await this.visibleTrip(caller, id);
    const r = t.routeId === null ? null : await this.repo.route(t.routeId);
    const stops =
      (t.routeStops as unknown as Stop[]).length > 0
        ? (t.routeStops as unknown as Stop[])
        : ((r?.stops ?? []) as unknown as Stop[]);
    const pos = { lat: num(t.lastLat), lng: num(t.lastLng) };
    const path = this.progress(stops, pos);
    const next = path.find((s) => s.state === 'NEXT') ?? null;
    return {
      tripId: t.id,
      tripNo: t.tripNo,
      status: t.status,
      speedKmh: num(t.lastSpeedKmh),
      remainingKm: num(t.remainingKm),
      position: pos.lat === null ? null : pos,
      lastPingAt: t.lastPingAt,
      pingAgeSec:
        t.lastPingAt === null ? null : Math.round((Date.now() - t.lastPingAt.getTime()) / 1000),
      network: t.network,
      nextMilestone:
        next === null ? null : { name: next.name, distanceKm: next.distanceKm, etaAt: t.etaAt },
      etaAt: t.etaAt,
    };
  }

  // ── W3.08 dispatched shipment views ──

  async dispatched(
    caller: Caller,
    f: { status?: string; q?: string; from?: string; to?: string; warehouseId?: string },
    p: Paging,
  ) {
    const page = await this.deps.fulfilmentQueries.shipmentPage(
      caller,
      {
        statuses: f.status === undefined ? ['DISPATCHED', 'OUT_FOR_DELIVERY'] : [f.status],
        ...(f.q === undefined ? {} : { q: f.q }),
        ...(f.from === undefined ? {} : { from: f.from }),
        ...(f.to === undefined ? {} : { to: f.to }),
        ...(f.warehouseId === undefined ? {} : { warehouseId: f.warehouseId }),
      },
      p,
    );
    const trips = await this.repo.tripsOfShipments(page.items.map((s) => s.id));
    const vehicles = new Map(
      (
        await this.repo.vehiclesByIds(
          trips.flatMap((t) => (t.vehicleId === null ? [] : [t.vehicleId])),
        )
      ).map((v) => [v.id, v]),
    );
    return {
      ...page,
      items: page.items.map((s) => {
        const t = trips.find((x) => x.shipments.some((y) => y.shipmentId === s.id));
        return {
          shipmentId: s.id,
          shipmentNo: s.shipmentNo,
          orderId: s.orderId,
          orderNo: s.orderNo,
          customer: s.farmName ?? s.customerName,
          destination: { district: s.district, pinCode: s.pinCode },
          status: s.status,
          dispatchedAt: s.dispatchedAt,
          weightKg: Number(s.weightKg.toFixed(3)),
          trip:
            t === undefined
              ? null
              : {
                  id: t.id,
                  tripNo: t.tripNo,
                  status: t.status,
                  etaAt: t.etaAt,
                  vehicle: t.vehicleId === null ? null : (vehicles.get(t.vehicleId)?.regNo ?? null),
                },
        };
      }),
    };
  }

  async shipmentSummary(caller: Caller, shipmentId: string) {
    const { s, t } = await this.shipmentTrip(caller, shipmentId);
    const doors =
      t?.dockDoorId == null ? [] : await this.deps.docksService.doorCodes([t.dockDoorId]);
    return {
      shipmentId: s.id,
      shipmentNo: s.shipmentNo,
      orderNo: s.orderNo,
      status: s.status,
      bay: t?.dockDoorId == null ? null : (doors[0]?.code ?? null),
      grossWeightKg: num(t?.grossKg) ?? s.weightKg,
      transit: t === null ? null : { status: t.status, etaAt: t.etaAt, departedAt: t.departedAt },
      destination: s.destination,
      customer: s.customer,
    };
  }

  async shipmentVehicle(caller: Caller, shipmentId: string) {
    const { t } = await this.shipmentTrip(caller, shipmentId);
    if (t === null) return { trip: null, partner: null, vehicle: null, driver: null };
    const [v, d, c] = await Promise.all([
      t.vehicleId === null ? null : this.repo.vehicle(t.vehicleId),
      t.driverId === null ? null : this.repo.driver(t.driverId),
      t.carrierId === null ? null : this.repo.carrier(t.carrierId),
    ]);
    return {
      trip: { id: t.id, tripNo: t.tripNo, type: t.type, status: t.status },
      partner: c === null ? null : { id: c.id, name: c.name, type: c.type },
      vehicle: v === null ? null : this.vehicleView(v),
      driver: d === null ? null : this.driverView(d),
    };
  }

  async shipmentTracking(caller: Caller, shipmentId: string) {
    const { t } = await this.shipmentTrip(caller, shipmentId);
    return t === null ? null : this.tracking(caller, t.id);
  }

  async shipmentDispatchInfo(caller: Caller, shipmentId: string) {
    const { s, t } = await this.shipmentTrip(caller, shipmentId);
    if (t === null)
      return {
        shipmentId,
        assignedAt: null,
        gateOut: null,
        etaAt: null,
        consignmentStatus: s.status,
        routePath: [],
      };
    const r = await this.route(caller, t.id);
    return {
      shipmentId,
      tripId: t.id,
      assignedAt: t.createdAt,
      gateOut:
        t.departedAt === null
          ? null
          : {
              at: t.departedAt,
              onTime: t.plannedDepartAt === null ? null : t.departedAt <= t.plannedDepartAt,
            },
      etaAt: t.etaAt,
      consignmentStatus: s.status,
      corridorName: r.route?.corridorName ?? null,
      routePath: r.stops,
    };
  }

  // ── W3.19 bulk & direct-to-farm ──

  async bulkKpis(caller: Caller, warehouseId: string | undefined) {
    const scope = this.scope(caller, warehouseId);
    const [counts, trips, vehicles] = await Promise.all([
      this.deps.fulfilmentQueries.bulkCounts(caller, warehouseId),
      this.repo.tripCounts(scope, warehouseId),
      this.repo.vehicles(scope, warehouseId === undefined ? {} : { warehouseId }),
    ]);
    const n = (st: readonly string[]) =>
      counts.filter((c) => st.includes(c.status)).reduce((x, c) => x + c.n, 0);
    const open = [
      'RELEASED',
      'ALLOCATED',
      'ASSIGNED',
      'PICKING',
      'PACKING',
      'QC',
      'READY_TO_DISPATCH',
    ];
    const bulkTrips = trips.filter((t) => t.type === 'BULK');
    return {
      activeConsignments: n(open),
      directToFarm: counts.filter((c) => open.includes(c.status)).reduce((x, c) => x + c.direct, 0),
      newToday: counts.reduce((x, c) => x + c.today, 0),
      ready: n(['READY_TO_DISPATCH']),
      inTransit: n(['DISPATCHED', 'OUT_FOR_DELIVERY']),
      vehicles: vehicles.filter((v) => v.status === 'ACTIVE').length,
      tripsActive: bulkTrips
        .filter((t) => ACTIVE_TRIP.includes(t.status))
        .reduce((x, t) => x + t.n, 0),
      tripsLoading: bulkTrips.filter((t) => t.status === 'LOADING').reduce((x, t) => x + t.n, 0),
      tabs: [
        { key: 'all', label: 'All', count: n(open) },
        {
          key: 'direct',
          label: 'Direct to farm',
          count: counts.filter((c) => open.includes(c.status)).reduce((x, c) => x + c.direct, 0),
        },
        { key: 'ready', label: 'Ready', count: n(['READY_TO_DISPATCH']) },
        { key: 'transit', label: 'In transit', count: n(['DISPATCHED', 'OUT_FOR_DELIVERY']) },
      ],
      modules: { rfid: false, fastag: false },
      asOf: new Date().toISOString(),
    };
  }

  async bulkOrders(
    caller: Caller,
    f: { tab?: string; q?: string; warehouseId?: string; status?: string },
    p: Paging,
  ) {
    const open = [
      'RELEASED',
      'ALLOCATED',
      'ASSIGNED',
      'PICKING',
      'PACKING',
      'QC',
      'READY_TO_DISPATCH',
    ];
    const statuses =
      f.status !== undefined
        ? [f.status]
        : f.tab === 'ready'
          ? ['READY_TO_DISPATCH']
          : f.tab === 'transit'
            ? ['DISPATCHED', 'OUT_FOR_DELIVERY']
            : open;
    const page = await this.deps.fulfilmentQueries.shipmentPage(
      caller,
      {
        statuses,
        bulk: true,
        ...(f.tab === 'direct' ? { directToFarm: true } : {}),
        ...(f.q === undefined ? {} : { q: f.q }),
        ...(f.warehouseId === undefined ? {} : { warehouseId: f.warehouseId }),
      },
      p,
    );
    const trips = await this.repo.tripsOfShipments(page.items.map((s) => s.id));
    const vehicles = new Map(
      (
        await this.repo.vehiclesByIds(
          trips.flatMap((t) => (t.vehicleId === null ? [] : [t.vehicleId])),
        )
      ).map((v) => [v.id, v]),
    );
    const doors = await this.deps.docksService.doorCodes(
      trips.flatMap((t) => (t.dockDoorId === null ? [] : [t.dockDoorId])),
    );
    return {
      ...page,
      items: page.items.map((s) => {
        const mine = trips.filter((t) => t.shipments.some((x) => x.shipmentId === s.id));
        const door = mine.find((t) => t.dockDoorId !== null);
        return {
          shipmentId: s.id,
          consignmentNo: s.shipmentNo,
          orderNo: s.orderNo,
          customer: s.farmName ?? s.customerName,
          directToFarm: s.warehouseType === 'MOTHER',
          destination: { district: s.district, pinCode: s.pinCode },
          weightKg: Number(s.weightKg.toFixed(3)),
          tonnes: Math.round(Number(s.weightKg.toString()) / 10) / 100,
          status: s.status,
          slot:
            door === undefined
              ? 'Unscheduled'
              : (doors.find((d) => d.id === door.dockDoorId)?.code ?? null),
          trucks: mine.map((t, i) => ({
            tripId: t.id,
            tripNo: t.tripNo,
            label: `Truck ${String(i + 1)}`,
            status: t.status,
            vehicle: t.vehicleId === null ? null : (vehicles.get(t.vehicleId)?.regNo ?? null),
            driverAssigned: t.driverId !== null,
          })),
        };
      }),
    };
  }

  async bays(caller: Caller, warehouseId: string) {
    caller.access.require('fulfilment.view', warehouseId);
    const scope = [warehouseId];
    const [doors, trips, turnaround] = await Promise.all([
      this.deps.docksService.doorsFacts(warehouseId),
      this.repo.trips(scope, { warehouseId, limit: 200, offset: null }),
      this.repo.avgTurnaroundMin(scope, warehouseId, new Date(Date.now() - 7 * 86_400_000)),
    ]);
    return {
      warehouseId,
      avgTurnaroundMinutes: turnaround,
      bays: doors.map((d) => {
        const loading = trips.find((t) => t.dockDoorId === d.id && t.status === 'LOADING');
        const queue = trips.filter((t) => t.dockDoorId === d.id && t.status === 'PLANNED');
        return {
          dockDoorId: d.id,
          code: d.code,
          name: d.name,
          equipment: d.equipment,
          vehicleClass: d.vehicleClass,
          status: d.status,
          heavy: d.equipment !== 'STANDARD' || d.vehicleClass === 'HEAVY_TRUCK',
          loadingPct: loading?.loadedPct ?? 0,
          loadingTrip: loading === undefined ? null : { id: loading.id, tripNo: loading.tripNo },
          queue: queue.map((t) => ({
            id: t.id,
            tripNo: t.tripNo,
            plannedDepartAt: t.plannedDepartAt,
          })),
        };
      }),
    };
  }

  async corridors(caller: Caller, warehouseId: string) {
    caller.access.require('fulfilment.view', warehouseId);
    const [routes, trips] = await Promise.all([
      this.repo.routes([warehouseId], { warehouseId, active: true }),
      this.repo.trips([warehouseId], { warehouseId, limit: 200, offset: null }),
    ]);
    return routes.map((r) => {
      const mine = trips.filter((t) => t.routeId === r.id && ACTIVE_TRIP.includes(t.status));
      return {
        routeId: r.id,
        code: r.code,
        name: r.name,
        corridorName: r.corridorName,
        stops: r.stops,
        activeTrips: mine.length,
        departed: mine.filter((t) => t.status === 'DEPARTED').length,
        consignments: mine.reduce((n, t) => n + t.shipments.length, 0),
      };
    });
  }

  async *bulkCsv(caller: Caller, f: { tab?: string; q?: string; warehouseId?: string }) {
    yield 'Consignment,Order,Customer,Direct to farm,District,PIN,Tonnes,Status,Slot,Trucks\n';
    let cursor: string | undefined;
    for (;;) {
      const page = await this.bulkOrders(caller, f, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const r of page.items)
        yield `${[
          r.consignmentNo,
          r.orderNo,
          r.customer,
          r.directToFarm,
          r.destination.district,
          r.destination.pinCode,
          r.tonnes,
          r.status,
          r.slot,
          r.trucks.map((t) => t.vehicle ?? t.tripNo).join(' / '),
        ]
          .map((v) => csvCell(v))
          .join(',')}\n`;
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
  }

  // ── 3PL driver links (§2a.8) ──

  /**
   * A trip link for a 3PL driver without a staff account: random 32-byte token (returned once,
   * stored as SHA-256), one trip, valid until completion + 12 h (or 48 h), revocable. The
   * dispatcher shares it (SMS through the notification provider when integrated).
   */
  async createLink(caller: Caller, tripId: string, input: { phone: string }) {
    const token = randomBytes(32).toString('base64url');
    const created = await this.deps.runInTransaction(async (tx) => {
      const t = await this.lockTrip(tx, caller, tripId);
      if (!ACTIVE_TRIP.includes(t.status))
        throw new ConflictError('The trip is closed', { details: { reason: 'TRIP_LOCKED' } });
      await this.repo.revokeLinks(tx, tripId);
      const l = await this.repo.createLink(tx, {
        tripId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        phone: input.phone,
        expiresAt: new Date(Date.now() + 48 * 3_600_000),
        createdBy: caller.userId,
      });
      await this.audit(tx, caller, 'dispatch.driver_link_created', tripId, {
        phoneLast4: input.phone.slice(-4),
      });
      return l;
    });
    const base = this.deps.config.DRIVER_LINK_BASE_URL ?? '/v1/driver/trips';
    return {
      tripId,
      url: `${base}/${token}`,
      token,
      expiresAt: created.expiresAt,
      modules: { sms: false },
    };
  }

  async revokeLink(caller: Caller, tripId: string) {
    const n = await this.deps.runInTransaction(async (tx) => {
      await this.lockTrip(tx, caller, tripId);
      const r = await this.repo.revokeLinks(tx, tripId);
      await this.audit(tx, caller, 'dispatch.driver_link_revoked', tripId, { revoked: r.count });
      return r.count;
    });
    return { revoked: n };
  }

  /** Token → trip (404 unknown; 410 expired / revoked / trip closed). */
  async resolveToken(token: string): Promise<TripRow> {
    const l = await this.repo.linkByHash(createHash('sha256').update(token).digest('hex'));
    if (l === null) throw new NotFoundError('Trip');
    if (l.revokedAt !== null || l.expiresAt.getTime() <= Date.now())
      throw new AppError(ErrorCode.CONFLICT, 'This trip link is no longer valid', 410, {
        details: { reason: 'LINK_EXPIRED' },
      });
    const t = await this.repo.trip(l.tripId);
    if (t === null || t.status === 'CANCELLED')
      throw new AppError(ErrorCode.CONFLICT, 'This trip link is no longer valid', 410, {
        details: { reason: 'LINK_EXPIRED' },
      });
    await this.repo.touchLink(l.id);
    return t;
  }

  /** Driver view: stops and drops only (no prices, no customer phone beyond the drop). */
  async driverTrip(token: string) {
    const t = await this.resolveToken(token);
    const facts = await this.deps.fulfilmentQueries.shipmentFacts(
      t.shipments.map((s) => s.shipmentId),
    );
    return {
      tripNo: t.tripNo,
      status: t.status,
      etaAt: t.etaAt,
      stops: (t.routeStops as unknown as Stop[]).map((s) => ({
        name: s.name,
        lat: s.lat,
        lng: s.lng,
      })),
      drops: facts.map((f) => ({
        shipmentId: f.id,
        shipmentNo: f.shipmentNo,
        status: f.status,
        units: f.units,
        destination: f.destination,
        customerName: f.customer.farmName ?? f.customer.name,
      })),
    };
  }

  async driverPing(
    token: string,
    p: {
      lat: number;
      lng: number;
      speedKmh?: number | null;
      remainingKm?: number | null;
      network?: string | null;
      at?: string | null;
    },
  ) {
    const t = await this.resolveToken(token);
    return this.ping(null, t.id, p, 'DRIVER_LINK');
  }

  /** The shipment must be on the link's trip. */
  async driverShipment(token: string, shipmentId: string): Promise<TripRow> {
    const t = await this.resolveToken(token);
    if (!t.shipments.some((s) => s.shipmentId === shipmentId)) throw new NotFoundError('Shipment');
    return t;
  }

  // ── for fulfilment (POD, customer app) ──

  async weighSlipOf(shipmentId: string) {
    const [t] = await this.repo.tripsOfShipments([shipmentId]);
    if (t?.weighedAt == null) return null;
    const urls =
      t.weighSlipMediaKey === null
        ? {}
        : await this.deps.mediaClient.signRead([t.weighSlipMediaKey]);
    return {
      tripNo: t.tripNo,
      netKg: num(t.netKg),
      slipNo: t.weighSlipNo,
      verified: t.weightVerified,
      url: t.weighSlipMediaKey === null ? null : (urls[t.weighSlipMediaKey] ?? null),
    };
  }

  async customerTracking(shipmentId: string) {
    const [t] = await this.repo.tripsOfShipments([shipmentId]);
    if (t === undefined) return null;
    return {
      status: t.status,
      etaAt: t.etaAt,
      lastPingAt: t.lastPingAt,
      position: t.lastLat === null ? null : { lat: num(t.lastLat), lng: num(t.lastLng) },
      remainingKm: num(t.remainingKm),
    };
  }

  // ── helpers ──

  /** Stops with PASSED / NEXT / UPCOMING from the current position (closest stop = reached). */
  private progress(stops: readonly Stop[], pos: { lat: number | null; lng: number | null }) {
    const d = stops.map((s) => km(pos, { lat: s.lat, lng: s.lng }));
    let closest = -1;
    let best = Number.POSITIVE_INFINITY;
    d.forEach((x, i) => {
      if (x !== null && x < best) {
        best = x;
        closest = i;
      }
    });
    // The closest stop is passed when we are within 2 km of it, or already nearer to the following
    // stop than the closest stop itself is (we are on the leg after it).
    const after = stops[closest + 1];
    const leg =
      after === undefined
        ? null
        : km({ lat: stops[closest]?.lat ?? null, lng: stops[closest]?.lng ?? null }, after);
    const toAfter = after === undefined ? null : km(pos, after);
    const passed = best <= 2 || (leg !== null && toAfter !== null && toAfter < leg);
    const nextIdx = closest === -1 ? 0 : passed ? closest + 1 : closest;
    return stops.map((s, i) => ({
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      shipmentId: s.shipmentId ?? null,
      distanceKm: d[i] ?? null,
      state:
        pos.lat === null
          ? 'UPCOMING'
          : i < nextIdx
            ? 'PASSED'
            : i === nextIdx
              ? 'NEXT'
              : 'UPCOMING',
    }));
  }

  private async tripViews(rows: readonly TripRow[]) {
    const [vehicles, drivers, carriers, routes] = await Promise.all([
      this.repo.vehiclesByIds(rows.flatMap((t) => (t.vehicleId === null ? [] : [t.vehicleId]))),
      this.repo.driversByIds(rows.flatMap((t) => (t.driverId === null ? [] : [t.driverId]))),
      this.repo.carriersByIds(rows.flatMap((t) => (t.carrierId === null ? [] : [t.carrierId]))),
      this.repo.routesByIds(rows.flatMap((t) => (t.routeId === null ? [] : [t.routeId]))),
    ]);
    return rows.map((t) => {
      const v = vehicles.find((x) => x.id === t.vehicleId);
      const d = drivers.find((x) => x.id === t.driverId);
      const c = carriers.find((x) => x.id === t.carrierId);
      const r = routes.find((x) => x.id === t.routeId);
      return {
        id: t.id,
        tripNo: t.tripNo,
        warehouseId: t.warehouseId,
        type: t.type,
        status: t.status,
        vehicle:
          v === undefined
            ? null
            : {
                id: v.id,
                regNo: v.regNo,
                vehicleClass: v.vehicleClass,
                capacityKg: num(v.capacityKg),
              },
        driver: d === undefined ? null : { id: d.id, name: d.name },
        carrier: c === undefined ? null : { id: c.id, name: c.name, type: c.type },
        route: r === undefined ? null : { id: r.id, code: r.code, name: r.name },
        dockDoorId: t.dockDoorId,
        shipments: t.shipments.length,
        plannedKg: t.shipments.reduce((n, s) => n + (num(s.plannedKg) ?? 0), 0),
        loadedPct: t.loadedPct,
        plannedDepartAt: t.plannedDepartAt,
        departedAt: t.departedAt,
        etaAt: t.etaAt,
        completedAt: t.completedAt,
        netKg: num(t.netKg),
        weightVerified: t.weightVerified,
        lastPingAt: t.lastPingAt,
        version: t.version,
      };
    });
  }

  private routeView(r: RouteRow) {
    return { ...r, stops: r.stops as unknown as Stop[] };
  }

  private vehicleView(v: VehicleRow) {
    return { ...v, capacityKg: num(v.capacityKg) };
  }

  private driverView(d: DriverRow) {
    return d;
  }

  private checkShipments(
    warehouseId: string,
    ids: readonly string[],
    facts: readonly { id: string; warehouseId: string; status: string; holdActive: boolean }[],
    allowed: readonly string[],
  ) {
    const issues: { path: string; message: string }[] = [];
    for (const id of ids) {
      const f = facts.find((x) => x.id === id);
      if (f === undefined) issues.push({ path: 'body.shipmentIds', message: `${id} not found` });
      else if (f.warehouseId !== warehouseId)
        issues.push({ path: 'body.shipmentIds', message: `${id} is at another warehouse` });
      else if (!allowed.includes(f.status))
        issues.push({ path: 'body.shipmentIds', message: `${id} is ${f.status}` });
    }
    if (issues.length > 0) throw new ValidationError(issues);
  }

  private async assertFree(
    tx: Tx,
    vehicleId: string | null,
    driverId: string | null,
    exceptTripId?: string,
  ) {
    if (vehicleId !== null) {
      const busy = await this.repo.activeTripOf(tx, 'vehicle', vehicleId, exceptTripId);
      if (busy !== null)
        throw new ConflictError(`The vehicle is on trip ${busy.tripNo}`, {
          details: { reason: 'VEHICLE_BUSY' },
        });
    }
    if (driverId !== null) {
      const busy = await this.repo.activeTripOf(tx, 'driver', driverId, exceptTripId);
      if (busy !== null)
        throw new ConflictError(`The driver is on trip ${busy.tripNo}`, {
          details: { reason: 'DRIVER_BUSY' },
        });
    }
  }

  private async shipmentTrip(caller: Caller, shipmentId: string) {
    const [s] = await this.deps.fulfilmentQueries.shipmentFacts([shipmentId]);
    if (s === undefined) throw new NotFoundError('Shipment');
    caller.access.require('fulfilment.view', s.warehouseId);
    const trips = await this.repo.tripsOfShipments([shipmentId]);
    return { s, t: trips[0] ?? null };
  }

  private async visibleTrip(caller: Caller, id: string) {
    const t = await this.repo.trip(id);
    if (t === null) throw new NotFoundError('Trip');
    caller.access.require('fulfilment.view', t.warehouseId);
    return t;
  }

  private async lockTrip(tx: Tx, caller: Caller, id: string, key = 'logistics.dispatch_assign') {
    const t = await this.repo.lockTrip(tx, id);
    if (t === null) throw new NotFoundError('Trip');
    caller.access.require(key, t.warehouseId);
    return t;
  }

  private scope(caller: Caller, warehouseId?: string) {
    if (warehouseId !== undefined) caller.access.require('fulfilment.view', warehouseId);
    return caller.access.scope('fulfilment.view');
  }

  private requireAnywhere(caller: Caller, key: string) {
    if (!caller.access.holdsAnywhere(key)) throw new ForbiddenError();
  }

  private async audit(
    tx: Tx,
    caller: Caller,
    action: string,
    id: string,
    after: unknown,
    reason: string | null = null,
  ) {
    await this.deps.auditService.record(
      tx,
      { userId: caller.userId, ip: caller.ip, requestId: caller.requestId },
      { action, targetType: 'trip', targetId: id, after: after as Record<string, unknown>, reason },
    );
  }
}
