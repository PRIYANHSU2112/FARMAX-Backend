import { NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { type Paging, decodeCursor, offsetOf, toPageResult } from '../../middleware/paging.js';
import type { ProcessingFilter } from './fulfilment.read.repository.js';
import {
  FULFILMENT_SETTINGS,
  type FulfilmentSettingKey,
  STAGES,
  STRIP,
  addDays,
  istDay,
  istStart,
  pct,
} from './fulfilment.rules.js';
import { FULFILMENT_KEYS } from './fulfilment.settings.js';

const KPI_TTL = 20;
const avg = (sum: number, n: number) => (n === 0 ? null : Math.round((sum / n) * 10) / 10);
const delta = (now: number | null, before: number | null) =>
  now === null || before === null
    ? null
    : before === 0
      ? null
      : Math.round(((now - before) / before) * 1000) / 10;

/**
 * Fulfilment reads (W3.01 dashboard, W3.07 processing lists, W4.05 reserved stock, badges,
 * readiness, sync status). KPI widgets read the daily counters / indexed counts, cached 20 s
 * (`fresh` bypasses); every widget is its own endpoint.
 */
export class FulfilmentQueries {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'fulfilmentReadRepository'
      | 'fulfilmentRepository'
      | 'fulfilmentSettings'
      | 'stockSettings'
      | 'warehousesService'
      | 'docksService'
      | 'storageService'
      | 'redis'
      | 'runInTransaction'
      | 'auditService'
      | 'atpService'
      | 'backordersRepository'
    >,
  ) {}

  private get read() {
    return this.deps.fulfilmentReadRepository;
  }

  scope(caller: Caller, warehouseId?: string) {
    if (warehouseId !== undefined) caller.access.require('fulfilment.view', warehouseId);
    return caller.access.scope('fulfilment.view');
  }

  private async cached<T>(
    caller: Caller,
    key: string,
    warehouseId: string | undefined,
    fresh: boolean,
    fn: () => Promise<T>,
  ): Promise<T> {
    const s = this.scope(caller, warehouseId);
    const k = `warehouse:fulfilment:q:${key}:${warehouseId ?? (s === 'ALL' ? 'ALL' : [...s].sort().join(','))}`;
    if (!fresh)
      try {
        const hit = await this.deps.redis.get(k);
        if (hit !== null) return JSON.parse(hit) as T;
      } catch {
        /* cache down → compute */
      }
    const v = await fn();
    try {
      await this.deps.redis.set(k, JSON.stringify(v), 'EX', KPI_TTL);
    } catch {
      /* best effort */
    }
    return v;
  }

  private range(from?: string, to?: string, days = 7) {
    const today = istDay(new Date());
    const t = to ?? today;
    const f = from ?? addDays(t, -(days - 1));
    if (f > t)
      throw new ValidationError([
        { path: 'querystring.from', message: 'must be on or before `to`' },
      ]);
    return { from: f, to: t };
  }

  // ── W3.01 dashboard ──

  async statusStrip(caller: Caller, warehouseId: string | undefined, fresh: boolean) {
    return this.cached(caller, 'strip', warehouseId, fresh, async () => {
      const scope = this.scope(caller, warehouseId);
      const [rows, tasks, nav] = await Promise.all([
        this.read.statusCounts(scope, warehouseId),
        this.read.activePickTasks(scope, warehouseId),
        this.read.navCounts(scope, warehouseId),
      ]);
      const n = (s: readonly string[]) =>
        rows.filter((r) => s.includes(r.status)).reduce((x, r) => x + r.n, 0);
      return {
        buckets: [
          ...STRIP.map((b) => ({ key: b.key, label: b.label, count: n(b.statuses) })),
          { key: 'EXCEPTIONS', label: 'Exceptions', count: nav.openExceptions },
        ],
        activePickTasks: tasks,
        trucksInTransit: null,
        onHold: nav.onHold,
        modules: { dispatch: false },
        asOf: new Date().toISOString(),
      };
    });
  }

  async kpis(caller: Caller, warehouseId: string | undefined, fresh: boolean) {
    return this.cached(caller, 'kpis', warehouseId, fresh, async () => {
      const scope = this.scope(caller, warehouseId);
      const today = istDay(new Date());
      const rows = await this.read.daily(scope, warehouseId, addDays(today, -13), today);
      const day = (d: string) => rows.find((r) => r.day.toISOString().slice(0, 10) === d);
      const sum = (from: string, to: string, f: (r: (typeof rows)[number]) => number) =>
        rows
          .filter((r) => {
            const d = r.day.toISOString().slice(0, 10);
            return d >= from && d <= to;
          })
          .reduce((n, r) => n + f(r), 0);
      const t = day(today);
      const y = day(addDays(today, -1));
      const last7 = { from: addDays(today, -6), to: today };
      const prev7 = { from: addDays(today, -13), to: addDays(today, -7) };
      const cyc = (r: { from: string; to: string }) =>
        avg(
          sum(r.from, r.to, (x) => x.cycleMinSum),
          sum(r.from, r.to, (x) => x.dispatched),
        );
      const onTime = (r: typeof t) =>
        r === undefined ? null : pct(r.onTimeDispatch, r.dispatched);
      const nav = await this.read.navCounts(scope, warehouseId);
      return {
        ordersReceived: {
          today: t?.received ?? 0,
          yesterday: y?.received ?? 0,
          change: delta(t?.received ?? 0, y?.received ?? 0),
        },
        dispatched: {
          today: t?.dispatched ?? 0,
          yesterday: y?.dispatched ?? 0,
          change: delta(t?.dispatched ?? 0, y?.dispatched ?? 0),
        },
        onTimeDispatchPct: {
          today: onTime(t),
          yesterday: onTime(y),
          change: delta(onTime(t), onTime(y)),
        },
        avgCycleMinutes: {
          last7Days: cyc(last7),
          previous7Days: cyc(prev7),
          change: delta(cyc(last7), cyc(prev7)),
        },
        openExceptions: {
          now: nav.openExceptions,
          openedToday: t?.exceptionsOpened ?? 0,
          openedYesterday: y?.exceptionsOpened ?? 0,
        },
        asOf: new Date().toISOString(),
      };
    });
  }

  async trend(caller: Caller, warehouseId: string | undefined, from?: string, to?: string) {
    const scope = this.scope(caller, warehouseId);
    const r = this.range(from, to, 7);
    const span =
      Math.round((istStart(r.to).getTime() - istStart(r.from).getTime()) / 86_400_000) + 1;
    if (span > 92)
      throw new ValidationError([{ path: 'querystring.from', message: 'at most 92 days' }]);
    const rows = await this.read.daily(scope, warehouseId, addDays(r.from, -span), r.to);
    const days = Array.from({ length: span }, (_, i) => addDays(r.from, i));
    const at = (d: string) => rows.find((x) => x.day.toISOString().slice(0, 10) === d);
    const series = days.map((d) => ({
      day: d,
      orders: at(d)?.received ?? 0,
      fulfilled: at(d)?.dispatched ?? 0,
    }));
    const prev = Array.from({ length: span }, (_, i) => addDays(r.from, i - span)).reduce(
      (n, d) => n + (at(d)?.dispatched ?? 0),
      0,
    );
    const cur = series.reduce((n, x) => n + x.fulfilled, 0);
    const cyc = days.reduce((n, d) => n + (at(d)?.cycleMinSum ?? 0), 0);
    return {
      from: r.from,
      to: r.to,
      series,
      totals: { orders: series.reduce((n, x) => n + x.orders, 0), fulfilled: cur },
      changePct: delta(cur, prev),
      meanTurnaroundMinutes: avg(cyc, cur),
      asOf: new Date().toISOString(),
    };
  }

  async fulfilmentRate(
    caller: Caller,
    warehouseId: string | undefined,
    from?: string,
    to?: string,
  ) {
    const scope = this.scope(caller, warehouseId);
    const r = this.range(from, to, 7);
    const s = await this.deps.fulfilmentSettings.all(warehouseId);
    const k = await this.read.fulfilmentRate(
      scope,
      warehouseId,
      istStart(r.from),
      new Date(istStart(r.to).getTime() + 86_400_000),
      s['fulfilment.onTimeWindowHours'],
      s['fulfilment.graceHours'],
    );
    return {
      from: r.from,
      to: r.to,
      ratePct: pct(k.onTime, k.due),
      due: k.due,
      onTime: k.onTime,
      segments: {
        withinWindow: k.withinWindow,
        bufferPickDelay: k.bufferDelay,
        critical: k.critical,
        late: k.late,
      },
      windowHours: s['fulfilment.onTimeWindowHours'],
      graceHours: s['fulfilment.graceHours'],
    };
  }

  async statusMix(caller: Caller, warehouseId: string | undefined, from?: string, to?: string) {
    const scope = this.scope(caller, warehouseId);
    const r = this.range(from, to, 30);
    const rows = await this.read.statusCounts(
      scope,
      warehouseId,
      istStart(r.from),
      new Date(istStart(r.to).getTime() + 86_400_000),
    );
    const total = rows.reduce((n, x) => n + x.n, 0);
    return {
      from: r.from,
      to: r.to,
      total,
      slices: [
        ...STRIP.map((b) => {
          const n = rows
            .filter((x) => b.statuses.includes(x.status as never))
            .reduce((a, x) => a + x.n, 0);
          return { key: b.key, label: b.label, count: n, pct: pct(n, total) };
        }),
        ...['CANCELLED', 'DELIVERY_FAILED', 'RETURNED_TO_WAREHOUSE'].map((st) => {
          const n = rows.find((x) => x.status === st)?.n ?? 0;
          return {
            key: st,
            label: st.replaceAll('_', ' ').toLowerCase(),
            count: n,
            pct: pct(n, total),
          };
        }),
      ],
    };
  }

  async recentOrders(caller: Caller, warehouseId: string | undefined, limit: number) {
    const scope = this.scope(caller, warehouseId);
    const rows = await this.read.recentShipments(scope, warehouseId, limit);
    const names = new Map(
      (
        await this.deps.warehousesService.findMany([...new Set(rows.map((r) => r.warehouseId))])
      ).map((w) => [w.id, w]),
    );
    const nav = await this.read.statusCounts(scope, warehouseId);
    return {
      activeCount: nav
        .filter((x) =>
          [
            'RELEASED',
            'ALLOCATED',
            'ASSIGNED',
            'PICKING',
            'PACKING',
            'QC',
            'READY_TO_DISPATCH',
          ].includes(x.status),
        )
        .reduce((n, x) => n + x.n, 0),
      items: rows.map((r) => ({
        shipmentId: r.id,
        shipmentNo: r.shipmentNo,
        orderId: r.orderId,
        orderNo: r.orderNo,
        customer: r.farmName ?? r.customerName,
        warehouse: names.get(r.warehouseId)?.code ?? null,
        status: r.status,
        eta: r.slaDueAt,
        route: null,
        itemsSummary: { skuCount: r.lineCount, weightKg: Number(r.weightKg.toFixed(3)) },
      })),
    };
  }

  async warehousePerformance(
    caller: Caller,
    from?: string,
    to?: string,
    groupBy: 'warehouse' | 'type' = 'warehouse',
  ) {
    const scope = caller.access.scope('fulfilment.view');
    const r = this.range(from, to, 7);
    const rows = await this.read.warehousePerformance(scope, r.from, r.to);
    const whs = new Map(
      (await this.deps.warehousesService.findMany(rows.map((x) => x.warehouseId))).map((w) => [
        w.id,
        w,
      ]),
    );
    const items = rows.map((x) => ({
      warehouseId: x.warehouseId,
      code: whs.get(x.warehouseId)?.code ?? null,
      name: whs.get(x.warehouseId)?.name ?? null,
      type: whs.get(x.warehouseId)?.type ?? null,
      received: x.received,
      dispatched: x.dispatched,
      fulfilled: x.fulfilled,
      onTimePct: pct(x.onTimeDispatch, x.dispatched),
      avgCycleMinutes: avg(x.cycleMinSum, x.dispatched),
      open: x.open,
      openExceptions: x.openExceptions,
    }));
    if (groupBy === 'warehouse') return { from: r.from, to: r.to, groupBy, items };
    const byType = new Map<string, typeof items>();
    for (const i of items)
      byType.set(i.type ?? 'UNKNOWN', [...(byType.get(i.type ?? 'UNKNOWN') ?? []), i]);
    return {
      from: r.from,
      to: r.to,
      groupBy,
      items: [...byType].map(([type, xs]) => ({
        type,
        warehouses: xs.length,
        received: xs.reduce((n, x) => n + x.received, 0),
        dispatched: xs.reduce((n, x) => n + x.dispatched, 0),
        open: xs.reduce((n, x) => n + x.open, 0),
        openExceptions: xs.reduce((n, x) => n + x.openExceptions, 0),
      })),
    };
  }

  async opsStatus(caller: Caller, warehouseId: string | undefined) {
    const scope = this.scope(caller, warehouseId);
    const [floor, s] = await Promise.all([
      this.deps.docksService.floorFacts(warehouseId === undefined ? scope : [warehouseId]),
      this.deps.fulfilmentSettings.all(warehouseId),
    ]);
    return {
      activeDocks: floor.docksInUse,
      dockDoors: floor.activeDoors,
      vehicleChecksPending: null,
      refreshAfterSec: s['fulfilment.refreshAfterSec'],
      modules: { dispatch: false },
      asOf: new Date().toISOString(),
    };
  }

  async syncStatus() {
    const lag = await this.read.outboxLag();
    return {
      eventsPending: lag.pending,
      oldestPendingAgeSec:
        lag.oldestAt === null ? 0 : Math.round((Date.now() - lag.oldestAt.getTime()) / 1000),
      healthy:
        lag.pending < 100 &&
        (lag.oldestAt === null || Date.now() - lag.oldestAt.getTime() < 60_000),
      storefrontPublishedAt: await this.deps.atpService.storefrontPublishedAt(),
      asOf: new Date().toISOString(),
    };
  }

  // ── W3.07 processing ──

  async processingCounts(
    caller: Caller,
    warehouseId: string | undefined,
    date: string | undefined,
  ) {
    const scope = this.scope(caller, warehouseId);
    const rows = await this.read.statusCounts(scope, warehouseId);
    const batch = await this.deps.fulfilmentRepository.openPickBatch(
      warehouseId === undefined ? scope : [warehouseId],
    );
    return {
      date: date ?? istDay(new Date()),
      tabs: Object.entries(STAGES).map(([key, statuses]) => ({
        key,
        count: rows
          .filter((r) => statuses.includes(r.status as never))
          .reduce((n, r) => n + r.n, 0),
      })),
      liveBatch:
        batch === null
          ? null
          : { id: batch.id, batchNo: batch.batchNo, createdAt: batch.createdAt },
    };
  }

  async processing(caller: Caller, f: ProcessingFilter, p: Paging) {
    const scope = this.scope(caller, f.warehouseId);
    const statuses = STAGES[f.stage ?? 'all'];
    if (statuses === undefined)
      throw new ValidationError([{ path: 'querystring.stage', message: 'unknown stage' }]);
    const offset = offsetOf(p);
    const [rows, total] = await Promise.all([
      this.read.processing(scope, f, statuses, {
        limit: p.limit,
        offset,
        after: decodeCursor(p.cursor),
      }),
      offset === null ? Promise.resolve(undefined) : this.read.processingCount(scope, f, statuses),
    ]);
    const page = toPageResult(rows, p, (r) => [r.slaDueAt?.toISOString() ?? null, r.id], total);
    const whs = new Map(
      (
        await this.deps.warehousesService.findMany([
          ...new Set(page.items.map((r) => r.warehouseId)),
        ])
      ).map((w) => [w.id, w]),
    );
    const now = Date.now();
    return {
      ...page,
      items: page.items.map((r) => ({
        shipmentId: r.id,
        shipmentNo: r.shipmentNo,
        orderId: r.orderId,
        orderNo: r.orderNo,
        customer: { name: r.farmName ?? r.customerName, segment: r.segment },
        warehouse: { id: r.warehouseId, code: whs.get(r.warehouseId)?.code ?? null },
        status: r.status,
        priority: r.priority,
        holdActive: r.holdActive,
        atRisk: r.atRisk || (r.slaDueAt !== null && r.slaDueAt.getTime() < now),
        slaDueAt: r.slaDueAt,
        items: r.lineCount,
        units: r.unitCount,
        weightKg: Number(r.weightKg.toFixed(3)),
        progress: {
          ordered: r.ordered,
          allocated: r.allocated,
          picked: r.picked,
          packed: r.packed,
        },
        operator: r.assigneeUserId === null ? null : { userId: r.assigneeUserId },
        taskId: r.taskId,
        pickBatchId: r.pickBatchId,
        stagingAreaId: r.stagingAreaId,
      })),
    };
  }

  async processingKpis(
    caller: Caller,
    warehouseId: string | undefined,
    date: string | undefined,
    fresh: boolean,
  ) {
    return this.cached(caller, `proc-kpis:${date ?? ''}`, warehouseId, fresh, async () => {
      const scope = this.scope(caller, warehouseId);
      const day = date ?? istDay(new Date());
      const [rows, s, staged, floor, qcHolds] = await Promise.all([
        this.read.daily(scope, warehouseId, day, day),
        this.deps.fulfilmentSettings.all(warehouseId),
        this.read.stagedPallets(scope, warehouseId),
        this.deps.docksService.floorFacts(warehouseId === undefined ? scope : [warehouseId]),
        this.read.qcHolds(scope, warehouseId),
      ]);
      const d = rows[0];
      const velocity = avg(d?.pickToPackMinSum ?? 0, d?.pickToPackCount ?? 0);
      return {
        date: day,
        pickingVelocity: {
          avgMinutes: velocity,
          targetMinutes: s['fulfilment.pickTargetMin'],
          onTarget: velocity === null ? null : velocity <= s['fulfilment.pickTargetMin'],
        },
        stagingBayLoad: {
          stagedPallets: staged,
          capacityPallets: floor.stagingCapacityPallets,
          pct: pct(staged, floor.stagingCapacityPallets),
        },
        qcFirstPass: {
          pct: pct(d?.qcFirst ?? 0, d?.qcTotal ?? 0),
          passed: d?.qcFirst ?? 0,
          checked: d?.qcTotal ?? 0,
          holds: qcHolds,
        },
        asOf: new Date().toISOString(),
      };
    });
  }

  // ── W4.05 reserved stock ──

  async reservedKpis(caller: Caller, warehouseId: string | undefined, fresh: boolean) {
    return this.cached(caller, 'reserved', warehouseId, fresh, async () => {
      const scope = this.scope(caller, warehouseId);
      const [k, policy] = await Promise.all([
        this.read.reservedKpis(scope, warehouseId),
        this.deps.stockSettings.get('stock.releasePolicy', warehouseId),
      ]);
      return {
        reservedPacks: k.reserved + k.picked,
        allocatedPacks: k.reserved,
        pickedPacks: k.picked,
        notAllocatedPacks: k.unallocated,
        reservedBatches: k.batches,
        releasePolicy: policy,
        asOf: new Date().toISOString(),
      };
    });
  }

  async reservations(
    caller: Caller,
    f: {
      tab: 'active' | 'picked' | 'released';
      warehouseId?: string;
      variantId?: string;
      q?: string;
    },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const offset = offsetOf(p);
    const rows = await this.read.reservations(scope, f, {
      limit: p.limit,
      offset,
      after: decodeCursor(p.cursor),
    });
    const page = toPageResult(rows, p, (r) => [r.id]);
    const bins = await this.deps.storageService.binLocations(
      page.items.flatMap((r) => (r.binId === null ? [] : [r.binId])),
    );
    const notAllocated =
      f.tab === 'active' && p.cursor === undefined && (p.page ?? 1) === 1
        ? await this.read.unallocatedDemand(scope, f, 50)
        : [];
    return {
      ...page,
      items: page.items.map((r) => ({
        allocationId: r.id,
        shipmentId: r.shipmentId,
        shipmentNo: r.shipmentNo,
        orderId: r.orderId,
        orderNo: r.orderNo,
        customer: r.customerName,
        warehouseId: r.warehouseId,
        variantId: r.variantId,
        sku: r.sku,
        productName: r.productName,
        batch: {
          id: r.batchId,
          batchNo: r.batchNo,
          expiryDate: r.expiryDate?.toISOString().slice(0, 10) ?? null,
        },
        bin: r.binId === null ? null : { id: r.binId, code: bins.get(r.binId)?.binCode ?? null },
        qty: r.qty,
        pickedQty: r.pickedQty,
        status: r.status,
        heldOrder: r.soft,
        isFefo: r.isFefo,
        reservedAt: r.createdAt,
        releasedAt: r.releasedAt,
        releaseReason: r.releaseReason,
        shipmentStatus: r.shipmentStatus,
      })),
      notAllocated: notAllocated.map((d) => ({
        ...d,
        batch: null,
        bin: null,
        label: 'Not allocated',
      })),
    };
  }

  async reservation(caller: Caller, allocationId: string) {
    const a = await this.deps.fulfilmentRepository.allocation(allocationId);
    if (a === null) throw new NotFoundError('Reservation');
    caller.access.require('fulfilment.view', a.warehouseId);
    const s = await this.deps.fulfilmentRepository.shipment(a.shipmentId);
    const bins = await this.deps.storageService.binLocations(a.binId === null ? [] : [a.binId]);
    return {
      ...a,
      bin: a.binId === null ? null : (bins.get(a.binId) ?? null),
      shipment:
        s === null
          ? null
          : {
              id: s.id,
              shipmentNo: s.shipmentNo,
              status: s.status,
              orderId: s.orderId,
              slaDueAt: s.slaDueAt,
            },
    };
  }

  // ── for the dispatch module (W3.08 / W3.19) ──

  /** Shipments with their order facts (staff screens; caller checked by the dispatch module). */
  async shipmentFacts(ids: readonly string[]) {
    const rows = await this.deps.fulfilmentRepository.shipmentsByIds(ids);
    const orders = new Map<string, Awaited<ReturnType<Cradle['fulfilmentRepository']['order']>>>();
    for (const o of new Set(rows.map((s) => s.orderId)))
      orders.set(o, await this.deps.fulfilmentRepository.order(o));
    return rows.map((s) => {
      const o = orders.get(s.orderId) ?? null;
      const ship = (o?.shipTo ?? {}) as Record<string, unknown>;
      return {
        id: s.id,
        shipmentNo: s.shipmentNo,
        orderId: s.orderId,
        orderNo: o?.orderNo ?? null,
        warehouseId: s.warehouseId,
        status: s.status,
        isBulk: s.isBulk,
        holdActive: s.holdActive,
        weightKg: Number(s.weightKg.toFixed(3)),
        value: s.value.toFixed(2),
        units: s.lines.reduce((n, l) => n + l.qty - l.cancelledQty, 0),
        palletCount: s.palletCount,
        slaDueAt: s.slaDueAt,
        stagedAt: s.stagedAt,
        dispatchedAt: s.dispatchedAt,
        outForDeliveryAt: s.outForDeliveryAt,
        deliveredAt: s.deliveredAt,
        stagingAreaId: s.stagingAreaId,
        routeId: s.routeId,
        dockBookingId: s.dockBookingId,
        customer: {
          name: o?.customerName ?? null,
          farmName: o?.farmName ?? null,
          phone: o?.customerPhone ?? null,
        },
        destination: {
          district: o?.district ?? null,
          pinCode: o?.pinCode ?? null,
          formatted: (ship.formatted as string | undefined) ?? null,
          lat: o?.latitude == null ? null : Number(o.latitude.toString()),
          lng: o?.longitude == null ? null : Number(o.longitude.toString()),
        },
      };
    });
  }

  async shipmentPage(
    caller: Caller,
    f: {
      statuses: readonly string[];
      q?: string;
      warehouseId?: string;
      customerId?: string;
      from?: string;
      to?: string;
      bulk?: boolean;
      directToFarm?: boolean;
    },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const offset = offsetOf(p);
    const { from, to, ...rest } = f;
    const filter = {
      ...rest,
      ...(from === undefined ? {} : { from: istStart(from) }),
      ...(to === undefined ? {} : { to: new Date(istStart(to).getTime() + 86_400_000) }),
    };
    const [rows, total] = await Promise.all([
      this.read.shipmentList(scope, filter, {
        limit: p.limit,
        offset,
        after: decodeCursor(p.cursor),
      }),
      offset === null ? Promise.resolve(undefined) : this.read.shipmentListCount(scope, filter),
    ]);
    return toPageResult(rows, p, (r) => [r.id], total);
  }

  /** W3.12: routed share + orders per rule in a period (GLOBAL facts for the routing engine). */
  routedStats(from: Date, to: Date) {
    return this.read.routedStats(from, to);
  }

  /** W3.12 node load: open shipments and today's released / dispatched per warehouse. */
  async nodeCounts() {
    const rows = await this.read.nodeCounts(
      ['RELEASED', 'ALLOCATED', 'ASSIGNED', 'PICKING', 'PACKING', 'QC', 'READY_TO_DISPATCH'],
      istStart(istDay(new Date())),
    );
    return new Map(rows.map((r) => [r.warehouseId, r]));
  }

  bulkCounts(caller: Caller, warehouseId: string | undefined) {
    return this.read.bulkCounts(
      this.scope(caller, warehouseId),
      warehouseId,
      istStart(istDay(new Date())),
    );
  }

  // ── badges, readiness ──

  async navCounts(caller: Caller, warehouseId?: string) {
    const scope = this.scope(caller, warehouseId);
    const [r, bo] = await Promise.all([
      this.read.navCounts(scope, warehouseId),
      this.deps.backordersRepository.counts(scope, warehouseId),
    ]);
    return { ...r, backorders: bo.find((b) => b.status === 'OPEN')?.n ?? 0 };
  }

  /** Readiness score (W4.00): % of open released demand coverable now from eligible stock. */
  async readiness(scope: 'ALL' | readonly string[], warehouseId?: string) {
    const [r, s] = await Promise.all([
      this.read.readiness(scope, warehouseId),
      this.deps.fulfilmentSettings.get('fulfilment.readinessBands', warehouseId),
    ]);
    const base = r.demand + r.allocated;
    const score = base === 0 ? 100 : Math.round(((r.allocated + r.covered) / base) * 1000) / 10;
    return {
      score,
      band: score >= s.optimal ? 'Optimal' : score >= s.watch ? 'Watch' : 'Critical',
      openUnits: base,
    };
  }

  // ── settings (W3 admin) ──

  async settings(scope = 'GLOBAL') {
    return this.deps.fulfilmentSettings.all(scope);
  }

  async putSettings(
    caller: Caller,
    scope: string,
    values: Partial<Record<FulfilmentSettingKey, unknown>>,
  ) {
    const bad = Object.keys(values).filter(
      (k) => !FULFILMENT_KEYS.includes(k as FulfilmentSettingKey),
    );
    if (bad.length > 0)
      throw new ValidationError(
        bad.map((k) => ({ path: `body.${k}`, message: 'unknown setting' })),
      );
    if (scope !== 'GLOBAL') caller.access.require('warehouse.configure', scope);
    await this.deps.runInTransaction(async (tx) => {
      for (const [k, v] of Object.entries(values))
        await this.deps.fulfilmentSettings.set(
          tx,
          k as FulfilmentSettingKey,
          v,
          caller.userId,
          scope,
        );
      await this.deps.auditService.record(
        tx,
        { userId: caller.userId, ip: caller.ip, requestId: caller.requestId },
        {
          action: 'fulfilment.settings_changed',
          targetType: 'fulfilment_settings',
          targetId: scope,
          after: values,
        },
      );
    });
    return this.deps.fulfilmentSettings.all(scope);
  }

  /** Restricted SKU quantities of a customer since a date (compliance ledger). */
  async customerPeriodQty(userId: string, variantIds: readonly string[], since: Date) {
    return await this.read.customerPeriodQty(userId, variantIds, since);
  }

  defaults() {
    return FULFILMENT_SETTINGS;
  }
}
