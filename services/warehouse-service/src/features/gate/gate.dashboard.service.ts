import { createHash } from 'node:crypto';

import { warehouseKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { readGateVersion } from '../../adapters/gate-version.js';
import type { Caller } from '../../middleware/guards.js';
import { type Paging, decodeCursor, toPageResult } from '../../middleware/paging.js';
import { dayBounds } from '../../middleware/time.js';
import type { WarehouseRecord } from '../warehouses/index.js';
import { TAB_STAGES, type Tab, etagOf, formatRegNo, minuteBucket } from './gate.rules.js';
import { shipmentListItem } from './gate.views.js';

export interface ListQuery {
  warehouseId: string;
  tab?: Tab;
  /** Filters modal: several tabs, comma-separated. */
  statuses?: string;
  q?: string;
  bayId?: string;
  from?: string;
  to?: string;
}

export interface Cached<T> {
  etag: string | null;
  body: T;
}

const CACHE_TTL = 60;
const ACTIVITY_TYPES = [
  'GATE_IN',
  'GROSS_CAPTURED',
  'TARE_CAPTURED',
  'GATE_OUT',
  'ENTRY_BLOCKED',
  'HELD',
  'TURNED_AWAY',
];
const ACTIVITY_LABEL: Record<
  string,
  { label: string; tone: 'success' | 'danger' | 'info' | 'warning' }
> = {
  GATE_IN: { label: 'Gate In', tone: 'success' },
  GROSS_CAPTURED: { label: 'Weighed in', tone: 'info' },
  TARE_CAPTURED: { label: 'Weighed out', tone: 'info' },
  GATE_OUT: { label: 'Gate Out', tone: 'danger' },
  ENTRY_BLOCKED: { label: 'Blocked', tone: 'danger' },
  HELD: { label: 'Weight hold', tone: 'warning' },
  TURNED_AWAY: { label: 'Turned away', tone: 'danger' },
};

const pct = (n: number, d: number) => (d <= 0 ? 0 : Math.round((n / d) * 1000) / 10);

/**
 * Gate dashboard (W5.01 / W5.01a, D-62): KPI cards, status donut, recent activity, the shipment
 * table and its tab badges — each its own call. Reads are cached in Redis under the warehouse's
 * gate version + the minute bucket (so time-based values such as "delayed" and "avg wait" refresh
 * every minute and a write is visible at once); the same parts form the ETag (30 s auto-refresh
 * → 304 with no DB hit). Redis down → computed from Postgres, no ETag.
 */
export class GateDashboardService {
  constructor(
    private readonly deps: Pick<Cradle, 'gateRepository' | 'gateSupport' | 'redis' | 'logger'>,
  ) {}

  private get repo() {
    return this.deps.gateRepository;
  }

  /** Version + minute bucket + query hash → ETag and cache key; body from Redis or computed. */
  async cached<T>(
    warehouseId: string,
    name: string,
    query: unknown,
    compute: () => Promise<T>,
    ifNoneMatch?: string,
  ): Promise<Cached<T> & { notModified: boolean }> {
    const version = await readGateVersion(this.deps.redis, warehouseId);
    if (version === null) return { etag: null, body: await compute(), notModified: false };
    const bucket = minuteBucket(Date.now());
    const hash = createHash('sha1')
      .update(JSON.stringify(query ?? null))
      .digest('hex')
      .slice(0, 12);
    const etag = etagOf(version, bucket, hash);
    if (ifNoneMatch !== undefined && ifNoneMatch === etag)
      return { etag, body: undefined as T, notModified: true };
    const key = warehouseKeys.gateCache(warehouseId, name, version, bucket, hash);
    try {
      const hit = await this.deps.redis.get(key);
      if (hit !== null) return { etag, body: JSON.parse(hit) as T, notModified: false };
    } catch {
      return { etag: null, body: await compute(), notModified: false };
    }
    const body = await compute();
    await this.deps.redis.set(key, JSON.stringify(body), 'EX', CACHE_TTL).catch(() => undefined);
    return { etag, body, notModified: false };
  }

  private async w(caller: Caller, warehouseId: string): Promise<WarehouseRecord> {
    return this.deps.gateSupport.warehouse(caller, warehouseId, 'gate.view');
  }

  /** W5.01 KPI cards + W5.01a empty-state cards (one SQL + two counts). */
  async summary(caller: Caller, warehouseId: string, ifNoneMatch?: string) {
    const w = await this.w(caller, warehouseId);
    return this.cached(
      w.id,
      'summary',
      {},
      async () => {
        const now = new Date();
        const today = this.deps.gateSupport.today(w, now);
        const yesterday = { from: new Date(today.from.getTime() - 86_400_000), to: today.from };
        const settings = await this.deps.gateSupport.settings(w.id);
        const grace = settings['gate.delayGraceMinutes'] * 60_000;
        const [s, scheduled, delayed, scales] = await Promise.all([
          this.repo.daySummary(w.id, today, yesterday, now),
          this.repo.scheduledBetween(w.id, today.from, today.to),
          this.repo.delayedCount(w.id, new Date(now.getTime() - grace), today.from),
          this.repo.scales(w.id),
        ]);
        const delta =
          s.weighedYesterday === 0
            ? null
            : Math.round(((s.weighedToday - s.weighedYesterday) / s.weighedYesterday) * 1000) / 10;
        const last = scales
          .map((x) => x.lastWeighedAt)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        return {
          date: today.date,
          cards: {
            totalWeighments: {
              value: s.weighedToday,
              deltaPct: delta,
              caption:
                delta === null
                  ? 'No weighments yesterday'
                  : `${delta >= 0 ? '+' : ''}${String(delta)}% vs yesterday`,
            },
            completed: {
              value: s.completedToday,
              throughputPct: pct(s.completedToday, s.weighedToday),
              caption: `${String(pct(s.completedToday, s.weighedToday))}% process throughput`,
            },
            activeWeighing: {
              value: s.active,
              avgWaitMins: s.avgWaitMin === null ? null : Math.round(s.avgWaitMin * 10) / 10,
              caption:
                s.avgWaitMin === null
                  ? 'No arrivals today'
                  : `Avg wait ${(Math.round(s.avgWaitMin * 10) / 10).toFixed(1)} mins`,
            },
            held: {
              value: s.held + s.blocked,
              breakdown: { held: s.held, blocked: s.blocked, rejectedInside: s.rejectedInside },
              caption: s.held + s.blocked > 0 ? 'Need attention' : 'Nothing held',
            },
          },
          emptyState: {
            todaysEntries: s.entriesToday,
            totalExit: s.exitsToday,
            inProgress: s.inside,
            scheduledToday: scheduled,
            empty: s.inside === 0 && scheduled === 0,
          },
          delayed,
          rejectedToday: s.rejectedToday,
          scale: {
            lastWeighedAt: last?.toISOString() ?? null,
            footer: last === undefined ? null : 'Weighbridge last weighed',
          },
          generatedAt: now.toISOString(),
        };
      },
      ifNoneMatch,
    );
  }

  /** W5.01 "Vehicle Entry Status" donut for a day. */
  async statusMix(
    caller: Caller,
    warehouseId: string,
    date: string | undefined,
    ifNoneMatch?: string,
  ) {
    const w = await this.w(caller, warehouseId);
    return this.cached(
      w.id,
      'mix',
      { date },
      async () => {
        const day = date ?? this.deps.gateSupport.today(w).date;
        const b = dayBounds(day, w.timezone);
        const m = await this.repo.countByStage({ warehouseId: w.id, from: b.from, to: b.to });
        const sum = (stages: readonly string[]) => stages.reduce((n, s) => n + (m.get(s) ?? 0), 0);
        const completed = sum(TAB_STAGES.completed);
        const inProgress = sum([...TAB_STAGES.inProgress, ...TAB_STAGES.blocked]);
        const pending = sum([...TAB_STAGES.expected, ...TAB_STAGES.arrived]);
        const total = completed + inProgress + pending;
        return {
          date: day,
          total,
          completedPct: pct(completed, total),
          segments: [
            { key: 'COMPLETED', label: 'Completed', count: completed, pct: pct(completed, total) },
            {
              key: 'IN_PROGRESS',
              label: 'In Progress',
              count: inProgress,
              pct: pct(inProgress, total),
            },
            { key: 'PENDING', label: 'Pending', count: pending, pct: pct(pending, total) },
          ],
        };
      },
      ifNoneMatch,
    );
  }

  async activity(caller: Caller, warehouseId: string, p: Paging) {
    const w = await this.w(caller, warehouseId);
    const c = decodeCursor(p.cursor);
    const after = c === null ? null : { at: new Date(String(c[0])), id: String(c[1]) };
    const rows = await this.repo.recentEvents(w.id, ACTIVITY_TYPES, after, p.limit);
    const page = toPageResult(rows, p, (r) => [r.at.toISOString(), r.id]);
    return {
      ...page,
      items: page.items.map((r) => {
        const d = (r.data ?? {}) as Record<string, unknown>;
        const meta = ACTIVITY_LABEL[r.type] ?? { label: r.type, tone: 'info' as const };
        const reg = typeof d.vehicleRegNo === 'string' ? d.vehicleRegNo : '';
        return {
          id: r.id,
          type: r.type,
          label: meta.label,
          tone: meta.tone,
          vehicleDisplay: formatRegNo(reg),
          entryNo: typeof d.entryNo === 'string' ? d.entryNo : null,
          gateEntryId: r.gateEntryId,
          shipmentId: r.shipmentId,
          at: r.at.toISOString(),
          tag:
            r.type === 'GROSS_CAPTURED' || r.type === 'TARE_CAPTURED'
              ? 'Weighed'
              : typeof d.bay === 'string'
                ? d.bay
                : null,
        };
      }),
    };
  }

  private filters(w: WarehouseRecord, q: ListQuery) {
    const today = this.deps.gateSupport.today(w).date;
    const from = dayBounds(q.from ?? today, w.timezone).from;
    const to = dayBounds(q.to ?? q.from ?? today, w.timezone).to;
    const tabs = (q.statuses ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is Exclude<Tab, 'all'> => s in TAB_STAGES);
    return {
      base: {
        warehouseId: w.id,
        from,
        to,
        ...(q.q === undefined ? {} : { q: q.q }),
        ...(q.bayId === undefined ? {} : { bayId: q.bayId }),
      },
      modalStages: tabs.length === 0 ? null : tabs.flatMap((t): string[] => [...TAB_STAGES[t]]),
    };
  }

  /** W5.01 table (keyset by ETA). */
  async shipments(caller: Caller, q: ListQuery, p: Paging) {
    const w = await this.w(caller, q.warehouseId);
    const f = this.filters(w, q);
    const tab = q.tab ?? 'all';
    const tabStages =
      tab === 'all' ? Object.values(TAB_STAGES).flatMap((s) => [...s]) : [...TAB_STAGES[tab]];
    const stages =
      f.modalStages === null ? tabStages : tabStages.filter((s) => f.modalStages?.includes(s));
    const c = decodeCursor(p.cursor);
    const after = c === null ? null : { etaAt: new Date(String(c[0])), id: String(c[1]) };
    const rows = await this.repo.listShipments({ ...f.base, stages }, after, p.limit);
    const now = new Date();
    const page = toPageResult(rows, p, (r) => [r.etaAt.toISOString(), r.id]);
    return { ...page, items: page.items.map((r) => shipmentListItem(r, now)) };
  }

  /** W5.01 tab badges (same filters as the table, all tabs). */
  async counts(caller: Caller, q: ListQuery, ifNoneMatch?: string) {
    const w = await this.w(caller, q.warehouseId);
    const f = this.filters(w, q);
    return this.cached(
      w.id,
      'counts',
      { ...q, warehouseId: undefined },
      async () => {
        const m = await this.repo.countByStage(f.base);
        const sum = (stages: readonly string[]) =>
          stages
            .filter((s) => f.modalStages === null || f.modalStages.includes(s))
            .reduce((n, s) => n + (m.get(s) ?? 0), 0);
        const tabs = {
          expected: sum(TAB_STAGES.expected),
          arrived: sum(TAB_STAGES.arrived),
          inProgress: sum(TAB_STAGES.inProgress),
          blocked: sum(TAB_STAGES.blocked),
          completed: sum(TAB_STAGES.completed),
        };
        return { all: Object.values(tabs).reduce((a, b) => a + b, 0), ...tabs };
      },
      ifNoneMatch,
    );
  }
}
