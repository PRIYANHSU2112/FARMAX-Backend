import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import { localDate } from '../../middleware/time.js';
import { TYPE_LABELS, stateName, usedPct } from '../warehouses/index.js';
import { deltaPct, isStale, statusBoard } from './stats.rules.js';
import {
  type CategoryRow,
  type CurrentRow,
  type DailyRow,
  type OverviewView,
  type StockByCategoryView,
  type StockFigures,
  UNCLASSIFIED,
} from './stats.types.js';

const COLD = new Set(['CC_REF', 'CC_FRZ']);

const minusDays = (ymd: string, days: number): string =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

const share = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.round((part / whole) * 1000) / 10;

/**
 * Warehouse stock numbers (D-56 P3). One BullMQ job pulls inventory-service's per-warehouse figures
 * every STATS_REFRESH_SECONDS into local read models; screens read only those rows (fast, and
 * still answer with the last snapshot + `stale: true` while inventory is down).
 */
export class StatsService {
  private readonly repo: Cradle['statsRepository'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly inventoryClient: Cradle['inventoryClient'];
  private readonly catalogClient: Cradle['catalogClient'];
  private readonly config: Cradle['config'];
  private readonly logger: Cradle['logger'];
  private readonly lazy: Pick<
    Cradle,
    | 'warehousesService'
    | 'ordersService'
    | 'calendarService'
    | 'storageService'
    | 'serviceAreasService'
  >;

  constructor(
    deps: Pick<
      Cradle,
      | 'statsRepository'
      | 'runInTransaction'
      | 'inventoryClient'
      | 'catalogClient'
      | 'config'
      | 'logger'
      | 'warehousesService'
      | 'ordersService'
      | 'calendarService'
      | 'storageService'
      | 'serviceAreasService'
    >,
  ) {
    this.repo = deps.statsRepository;
    this.runInTransaction = deps.runInTransaction;
    this.inventoryClient = deps.inventoryClient;
    this.catalogClient = deps.catalogClient;
    this.config = deps.config;
    this.logger = deps.logger;
    this.lazy = deps;
  }

  // ── Job ──

  /** Pull inventory figures → current + by-category rows + today's daily row, in one transaction. */
  async refresh(now = new Date()): Promise<{ warehouses: number } | { skipped: true }> {
    const stats = await this.inventoryClient.warehouseStats();
    if (stats === null) return { skipped: true };
    const warehouses = await this.lazy.warehousesService.visible('ALL');
    const ids = warehouses.map((w) => w.id);
    const byId = new Map(stats.map((s) => [s.warehouseId, s]));
    const orders = await this.lazy.ordersService.openCounts(ids);
    const current: CurrentRow[] = [];
    const categories: CategoryRow[] = [];
    const daily: DailyRow[] = [];
    for (const w of warehouses) {
      const s = byId.get(w.id);
      current.push({
        warehouseId: w.id,
        onHand: s?.onHand ?? 0,
        reserved: s?.reserved ?? 0,
        damaged: s?.damaged ?? 0,
        available: s?.available ?? 0,
        skuCount: s?.skuCount ?? 0,
        usedKg: s?.usedKg ?? '0',
        weighedUnits: s?.weighedUnits ?? 0,
        unweighedUnits: s?.unweighedUnits ?? 0,
        unweighedSkus: s?.unweighedSkus ?? 0,
        weightKnownPct: String(s?.weightKnownPct ?? 100),
        asOf: now,
      });
      for (const c of s?.categories ?? [])
        categories.push({
          warehouseId: w.id,
          rootCategoryId: c.rootCategoryId ?? UNCLASSIFIED,
          skuCount: c.skuCount,
          onHand: c.onHand,
          reserved: c.reserved,
          available: c.available,
        });
      const open = orders.get(w.id);
      daily.push({
        warehouseId: w.id,
        day: localDate(now, w.timezone),
        onHand: s?.onHand ?? 0,
        available: s?.available ?? 0,
        reserved: s?.reserved ?? 0,
        openOrders: (open?.new ?? 0) + (open?.allocated ?? 0),
      });
    }
    await this.runInTransaction(async (tx) => {
      await this.repo.replace(tx, ids, current, categories);
      await this.repo.upsertDaily(tx, daily);
    });
    this.logger.debug({ warehouses: ids.length }, 'warehouse stats refreshed');
    return { warehouses: ids.length };
  }

  // ── For other features (through index.ts) ──

  async figures(ids: readonly string[], now = new Date()): Promise<Map<string, StockFigures>> {
    const rows = await this.repo.current(ids);
    return new Map(
      [...rows].map(([id, r]) => [
        id,
        {
          onHand: r.onHand,
          available: r.available,
          reserved: r.reserved,
          damaged: r.damaged,
          skuCount: r.skuCount,
          usedKg: r.usedKg,
          weightKnownPct: Number(r.weightKnownPct),
          unweighedSkus: r.unweighedSkus,
          asOf: r.asOf.toISOString(),
          stale: isStale(r.asOf, now, this.config.STATS_REFRESH_SECONDS),
        },
      ]),
    );
  }

  // ── Reads ──

  async overview(caller: Caller, id: string): Promise<OverviewView> {
    const w = await this.lazy.warehousesService.requireVisible(caller, id, 'warehouse.view');
    const now = new Date();
    const today = localDate(now, w.timezone);
    const [current, counts, history, calendar, zones, areas] = await Promise.all([
      this.repo.current([id]),
      this.lazy.ordersService.openCounts([id]),
      this.repo.daily(id, [minusDays(today, 1), minusDays(today, 7)]),
      this.lazy.calendarService.get(caller, id),
      this.lazy.storageService.zones(caller, id),
      this.lazy.serviceAreasService.list(caller, id),
    ]);
    const c = current.get(id);
    const week = history.get(minusDays(today, 7));
    const yesterday = history.get(minusDays(today, 1));
    const open = counts.get(id) ?? { new: 0, allocated: 0 };
    const openTotal = open.new + open.allocated;
    const capacityKg = w.capacityKg === null ? null : num(w.capacityKg);
    const usedKg = c === undefined ? null : num(c.usedKg);
    const coldZones = zones.filter((z) => COLD.has(z.temperatureClass));
    const stateCodes = [
      ...new Set(areas.areas.map((a) => a.stateCode).filter((s): s is string => s !== null)),
    ].sort();
    const trend = (value: number, before: number | undefined) => ({
      value,
      vsLast7DaysPct: deltaPct(value, before),
    });
    return {
      warehouseId: id,
      asOf: c?.asOf.toISOString() ?? null,
      stale: isStale(c?.asOf ?? null, now, this.config.STATS_REFRESH_SECONDS),
      stock: {
        onHand: trend(c?.onHand ?? 0, week?.onHand),
        available: trend(c?.available ?? 0, week?.available),
        reserved: trend(c?.reserved ?? 0, week?.reserved),
        skuCount: c?.skuCount ?? 0,
      },
      activeOrders: {
        new: open.new,
        allocated: open.allocated,
        total: openTotal,
        inPicking: null,
        inPacking: null,
        readyToDispatch: null,
      },
      ordersToProcess: {
        count: openTotal,
        vsYesterdayPct: deltaPct(openTotal, yesterday?.openOrders),
      },
      transfers: { inbound: null, outbound: null },
      onTimeDispatchPct: null,
      performance: {
        otifPct: null,
        pickAccuracyPct: null,
        dockToStockHours: null,
        cycleTimeHours: null,
      },
      capacity: {
        totalKg: capacityKg === null ? null : capacityKg.toFixed(2),
        usedKg: usedKg === null ? null : usedKg.toFixed(2),
        availableKg:
          capacityKg === null || usedKg === null
            ? null
            : Math.max(capacityKg - usedKg, 0).toFixed(2),
        usedPct: usedKg === null ? null : usedPct(usedKg, capacityKg),
        weightKnownPct: c === undefined ? null : Number(c.weightKnownPct),
        unweighedSkus: c?.unweighedSkus ?? null,
      },
      statusBoard: statusBoard({
        status: w.status,
        today: {
          isOpen: calendar.today.isOpen,
          limitedHoliday: calendar.today.holiday?.mode === 'LIMITED',
        },
        coldZones: {
          total: coldZones.length,
          active: coldZones.filter((z) => z.status === 'ACTIVE').length,
        },
        asOf: c?.asOf ?? null,
        now,
      }),
      info: {
        typeLabel: TYPE_LABELS[w.type],
        serviceArea: {
          stateCodes,
          stateNames: stateCodes.map((s) => stateName(s) ?? s),
          districts: areas.summary.districts,
          pinCodes: areas.summary.pinCodes,
        },
        operatingHoursToday: {
          isOpen: calendar.today.isOpen,
          opensAt: calendar.today.opensAt,
          closesAt: calendar.today.closesAt,
          holiday: calendar.today.holiday?.name ?? null,
        },
        updatedAt: w.updatedAt.toISOString(),
      },
      modules: { transfers: false, picking: false, performance: false, nearExpiry: false },
    };
  }

  async stockByCategory(caller: Caller, id: string): Promise<StockByCategoryView> {
    await this.lazy.warehousesService.requireVisible(caller, id, 'warehouse.view');
    const [current, rows, names] = await Promise.all([
      this.repo.current([id]),
      this.repo.categories(id),
      this.catalogClient.categories(),
    ]);
    const c = current.get(id);
    const totals = rows.reduce(
      (t, r) => ({
        skuCount: t.skuCount + r.skuCount,
        onHand: t.onHand + r.onHand,
        reserved: t.reserved + r.reserved,
        available: t.available + r.available,
      }),
      { skuCount: 0, onHand: 0, reserved: 0, available: 0 },
    );
    return {
      warehouseId: id,
      asOf: c?.asOf.toISOString() ?? null,
      stale: isStale(c?.asOf ?? null, new Date(), this.config.STATS_REFRESH_SECONDS),
      totals,
      unweighedSkus: c?.unweighedSkus ?? 0,
      categories: rows.map((r) => {
        const rootCategoryId = r.rootCategoryId === UNCLASSIFIED ? null : r.rootCategoryId;
        return {
          rootCategoryId,
          name: rootCategoryId === null ? null : (names?.get(rootCategoryId) ?? null),
          skuCount: r.skuCount,
          onHand: r.onHand,
          reserved: r.reserved,
          available: r.available,
          sharePct: share(r.onHand, totals.onHand),
          nearExpiry: null,
        };
      }),
      modules: { nearExpiry: false },
    };
  }
}
