import type { Tx } from '@farmx/database';
import type { AvailabilityChangedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import {
  type Paging,
  csvCell,
  decodeCursor,
  offsetOf,
  toPageResult,
} from '../../middleware/paging.js';
import type { AtpFilter, AtpParams, AtpRow, AtpSort } from './atp.repository.js';

const actorOf = (c: Caller) => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });
const KPI_TTL = 20;
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

const STORAGE: Record<string, string> = {
  AMB: 'Ambient',
  AMB_CTL: 'Ambient (controlled)',
  CC_REF: 'Cold chain 2–8 °C',
  CC_FRZ: 'Frozen',
  HAZ: 'Hazardous',
};
const HEALTH_LABEL = { HEALTHY: 'Healthy', HIGH_DEMAND: 'High Demand', LOW_BUFFER: 'Low Buffer' };

const DEFAULTS = {
  'atp.healthBands': { healthy: 35, low: 10 },
  'atp.storefrontChannels': ['FARMX_APP'],
  'atp.lastBufferFloorPct': 10,
} as const;

export interface AtpSettingsInput {
  healthBands?: { healthy: number; low: number };
  storefrontChannels?: string[];
  guardrailsEnabled?: boolean;
  bufferFloorPct?: number;
  cartHoldLeaseSeconds?: number;
  reason: string;
}

/**
 * Available-to-Promise (D-57b W3.13). Figures come from WMS stock (the physical truth), open
 * shipment demand, thresholds and inbound transfers; what the storefront shows comes from
 * `inventory.availability_changed.v1` (storefront sync). Inventory owns the buffer floor and the
 * cart-hold lease (reservation TTL); WMS edits them through inventory's internal API.
 */
export class AtpService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'atpRepository'
      | 'stockSettings'
      | 'inventoryClient'
      | 'catalogClient'
      | 'warehousesService'
      | 'runInTransaction'
      | 'auditService'
      | 'redis'
    >,
  ) {}

  private get repo() {
    return this.deps.atpRepository;
  }

  private scope(caller: Caller, warehouseId?: string) {
    if (warehouseId !== undefined) caller.access.require('inventory.view', warehouseId);
    return caller.access.scope('inventory.view');
  }

  private async params(): Promise<AtpParams & { healthy: number; low: number }> {
    const [raw, inv] = await Promise.all([
      this.deps.stockSettings.raw(['atp.healthBands']),
      this.cachedInventorySettings(),
    ]);
    const bands =
      (raw.get('atp.healthBands') as { healthy: number; low: number } | undefined) ??
      DEFAULTS['atp.healthBands'];
    return {
      healthyPct: bands.healthy,
      lowPct: bands.low,
      floorPct: inv?.bufferFloorPct ?? 0,
      healthy: bands.healthy,
      low: bands.low,
    };
  }

  /** Inventory settings change rarely: 30 s in Redis (null = inventory down). */
  private async cachedInventorySettings() {
    const k = 'warehouse:atp:inventory-settings';
    try {
      const hit = await this.deps.redis.get(k);
      if (hit !== null)
        return JSON.parse(hit) as Awaited<
          ReturnType<Cradle['inventoryClient']['availabilitySettings']>
        >;
    } catch {
      /* cache down */
    }
    const v = await this.deps.inventoryClient.availabilitySettings();
    if (v !== null)
      try {
        await this.deps.redis.set(k, JSON.stringify(v), 'EX', 30);
      } catch {
        /* best effort */
      }
    return v;
  }

  private async cached<T>(key: string, fresh: boolean, fn: () => Promise<T>): Promise<T> {
    const k = `warehouse:atp:q:${key}`;
    if (!fresh)
      try {
        const hit = await this.deps.redis.get(k);
        if (hit !== null) return JSON.parse(hit) as T;
      } catch {
        /* compute */
      }
    const v = await fn();
    try {
      await this.deps.redis.set(k, JSON.stringify(v), 'EX', KPI_TTL);
    } catch {
      /* best effort */
    }
    return v;
  }

  private scopeKey(caller: Caller, f: AtpFilter) {
    const s = this.scope(caller, f.warehouseId);
    return JSON.stringify([
      f.warehouseId ?? (s === 'ALL' ? 'ALL' : [...s].sort()),
      f.categoryId ?? null,
      f.temperatureClass ?? null,
    ]);
  }

  // ── W3.13 widgets ──

  async kpis(caller: Caller, f: AtpFilter, fresh = false) {
    const scope = this.scope(caller, f.warehouseId);
    return this.cached(`kpis:${this.scopeKey(caller, f)}`, fresh, async () => {
      const [p, sf] = await Promise.all([this.params(), this.repo.storefrontStats()]);
      const t = await this.repo.totals(scope, f, p);
      const z = t ?? {
        skus: 0,
        physical: 0,
        available: 0,
        allocated: 0,
        onFloor: 0,
        qcHold: 0,
        blocked: 0,
        returned: 0,
        safety: 0,
        demand: 0,
        inbound: 0,
        netAtp: 0,
        projected: 0,
        healthy: 0,
        highDemand: 0,
        lowBuffer: 0,
        throttled: 0,
        out: 0,
      };
      return {
        physical: z.physical,
        openDemand: z.demand,
        allocated: z.allocated,
        pickingPacking: z.onFloor,
        pickingPackingSharePct: pct(z.onFloor, z.allocated),
        netAtp: z.netAtp,
        availabilityRatePct: pct(z.netAtp, z.physical),
        projected24h: z.projected,
        inbound24h: z.inbound,
        safetyStock: z.safety,
        qcHold: z.qcHold,
        blocked: z.blocked,
        returned: z.returned,
        skus: z.skus,
        health: {
          healthy: z.healthy,
          highDemand: z.highDemand,
          lowBuffer: z.lowBuffer,
          throttled: z.throttled,
          outOfStock: z.out,
        },
        storefront: {
          variants: sf.variants,
          inStock: sf.inStock,
          lastPublishedAt: sf.lastAt,
        },
        bands: { healthy: p.healthy, low: p.low, bufferFloorPct: p.floorPct },
        asOf: new Date(),
      };
    });
  }

  async categories(caller: Caller, warehouseId?: string) {
    const scope = this.scope(caller, warehouseId);
    const [rows, names] = await Promise.all([
      this.repo.categories(scope, warehouseId),
      this.deps.catalogClient.categories(),
    ]);
    return {
      total: rows.reduce((n, r) => n + r.skus, 0),
      categories: rows.map((r) => ({
        categoryId: r.rootCategoryId,
        name: r.rootCategoryId === null ? 'Uncategorised' : (names?.get(r.rootCategoryId) ?? null),
        skus: r.skus,
        physical: r.physical,
      })),
      modules: { catalog: names !== null },
    };
  }

  async items(caller: Caller, f: AtpFilter, sort: AtpSort, desc: boolean, p: Paging) {
    const scope = this.scope(caller, f.warehouseId);
    const params = await this.params();
    const offset = offsetOf(p);
    const rows = await this.repo.rows(scope, f, params, sort, desc, {
      limit: p.limit,
      offset,
      after: offset === null ? decodeCursor(p.cursor) : null,
    });
    const total = offset === null ? undefined : await this.repo.count(scope, f, params);
    const page = toPageResult(rows, p, (r) => [r[sort], r.warehouseId, r.variantId], total);
    return { ...page, items: await this.views(page.items) };
  }

  async *exportCsv(caller: Caller, f: AtpFilter): AsyncGenerator<string> {
    const scope = this.scope(caller, f.warehouseId);
    const params = await this.params();
    yield 'warehouse,sku,name,category,storage,physical,open_demand,safety,qc_hold,blocked,returned,net_atp,inbound_24h,projected_24h,health,throttled,storefront_qty,top_lot,expiry\n';
    let after: readonly unknown[] | null = null;
    for (;;) {
      const rows: AtpRow[] = await this.repo.rows(scope, f, params, 'netAtp', false, {
        limit: 1000,
        offset: null,
        after,
      });
      const batch = rows.slice(0, 1000);
      for (const r of await this.views(batch))
        yield `${[
          r.warehouse?.code ?? r.warehouseId,
          r.sku,
          r.name,
          r.category?.name ?? null,
          r.storageType,
          r.physical,
          r.openDemand,
          r.safetyStock,
          r.qcHold,
          r.blocked,
          r.returned,
          r.netAtp,
          r.inbound24h,
          r.projected24h,
          r.healthLabel,
          r.throttled,
          r.storefront?.publishedQty ?? null,
          r.topLot?.batchNo ?? null,
          r.topLot?.expiryDate ?? null,
        ]
          .map((v) => csvCell(v))
          .join(',')}\n`;
      const last = batch.at(-1);
      if (rows.length <= 1000 || last === undefined) break;
      after = [last.netAtp, last.warehouseId, last.variantId];
    }
  }

  async nodeDistribution(caller: Caller) {
    const scope = caller.access.scope('inventory.view');
    const [p, whs] = await Promise.all([this.params(), this.deps.warehousesService.visible(scope)]);
    const [nodes, atp] = await Promise.all([this.repo.nodes(scope), this.repo.nodeAtp(scope, p)]);
    const byAtp = new Map(atp.map((a) => [a.warehouseId, a]));
    const byNode = new Map(nodes.map((n) => [n.warehouseId, n]));
    const total = nodes.reduce((n, x) => n + x.physical, 0);
    return {
      totalPhysical: total,
      nodes: whs
        // A draft (SETUP) node shows only once it holds stock or has transfers coming.
        .filter((w) => w.status !== 'SETUP' || byNode.has(w.id))
        .map((w) => {
          const n = byNode.get(w.id);
          const a = byAtp.get(w.id);
          return {
            warehouseId: w.id,
            code: w.code,
            name: w.name,
            type: w.type,
            tagline: w.tagline,
            status: w.status,
            physical: n?.physical ?? 0,
            available: n?.available ?? 0,
            allocated: n?.allocated ?? 0,
            skusInStock: n?.skus ?? 0,
            sharePct: pct(n?.physical ?? 0, total),
            netAtp: a?.netAtp ?? 0,
            projected24h: a?.projected ?? 0,
            openDemand: a?.demand ?? 0,
            pipeline: {
              inboundUnits: n?.inboundUnits ?? 0,
              transfers: n?.inboundTransfers ?? 0,
              nextEtaAt: n?.nextEtaAt ?? null,
            },
          };
        })
        .sort((x, y) => y.physical - x.physical),
      asOf: new Date(),
    };
  }

  // ── Settings + sync ──

  async settings() {
    const [raw, inv] = await Promise.all([
      this.deps.stockSettings.raw(['atp.healthBands', 'atp.storefrontChannels']),
      this.deps.inventoryClient.availabilitySettings(),
    ]);
    const bands =
      (raw.get('atp.healthBands') as { healthy: number; low: number } | undefined) ??
      DEFAULTS['atp.healthBands'];
    return {
      formula: {
        netAtp:
          'Physical − open demand (undispatched order lines) − safety stock − QC hold − quarantined − damaged − expired − returned (never below 0).',
        projected24h: 'Net ATP + transfers arriving within 24 hours.',
        storefront:
          'The app shows inventory sellable stock (on hand − reserved − safety); stock at or below reorder level × buffer floor % is hidden ("Throttled").',
      },
      healthBands: {
        ...bands,
        basis: 'Net ATP ÷ target stock (reorder level when no target).',
        labels: HEALTH_LABEL,
      },
      guardrailsEnabled: inv === null ? null : inv.bufferFloorPct > 0,
      bufferFloorPct: inv?.bufferFloorPct ?? null,
      cartHoldLeaseSeconds: inv?.reservationTtlSeconds ?? null,
      allowSplitAllocation: inv?.allowSplitAllocation ?? null,
      storefrontChannels:
        (raw.get('atp.storefrontChannels') as string[] | undefined) ??
        DEFAULTS['atp.storefrontChannels'],
      modules: { inventory: inv !== null, shopify: false },
    };
  }

  async putSettings(caller: Caller, input: AtpSettingsInput) {
    const raw = await this.deps.stockSettings.raw(['atp.lastBufferFloorPct']);
    const cur = await this.deps.inventoryClient.availabilitySettings();
    let floor = input.bufferFloorPct;
    if (input.guardrailsEnabled === false) floor = 0;
    else if (input.guardrailsEnabled === true && floor === undefined && cur?.bufferFloorPct === 0)
      floor =
        (raw.get('atp.lastBufferFloorPct') as number | undefined) ??
        DEFAULTS['atp.lastBufferFloorPct'];
    if (floor !== undefined || input.cartHoldLeaseSeconds !== undefined) {
      await this.deps.inventoryClient.setAvailabilitySettings({
        ...(floor === undefined ? {} : { bufferFloorPct: floor }),
        ...(input.cartHoldLeaseSeconds === undefined
          ? {}
          : { reservationTtlSeconds: input.cartHoldLeaseSeconds }),
        reason: input.reason,
        by: caller.userId,
        requestId: caller.requestId,
      });
      try {
        await this.deps.redis.del('warehouse:atp:inventory-settings');
      } catch {
        /* expires anyway */
      }
    }
    await this.deps.runInTransaction(async (tx) => {
      const s = this.deps.stockSettings;
      if (input.healthBands !== undefined)
        await s.setRaw(tx, 'atp.healthBands', input.healthBands, caller.userId);
      if (input.storefrontChannels !== undefined)
        await s.setRaw(tx, 'atp.storefrontChannels', input.storefrontChannels, caller.userId);
      if (floor === 0 && cur !== null && cur.bufferFloorPct > 0)
        await s.setRaw(tx, 'atp.lastBufferFloorPct', cur.bufferFloorPct, caller.userId);
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'atp.settings_update',
        targetType: 'atp_settings',
        targetId: 'atp',
        before:
          cur === null
            ? null
            : {
                bufferFloorPct: cur.bufferFloorPct,
                cartHoldLeaseSeconds: cur.reservationTtlSeconds,
              },
        after: {
          ...(input.healthBands === undefined ? {} : { healthBands: input.healthBands }),
          ...(input.storefrontChannels === undefined
            ? {}
            : { storefrontChannels: input.storefrontChannels }),
          ...(floor === undefined ? {} : { bufferFloorPct: floor }),
          ...(input.cartHoldLeaseSeconds === undefined
            ? {}
            : { cartHoldLeaseSeconds: input.cartHoldLeaseSeconds }),
        },
        reason: input.reason,
      });
    });
    return this.settings();
  }

  /** "Sync Now": inventory re-sends storefront availability (of one warehouse). */
  async sync(caller: Caller, warehouseId: string | null) {
    if (warehouseId !== null) caller.access.require('inventory.view', warehouseId);
    const r = await this.deps.inventoryClient.resyncAvailability(warehouseId);
    return { ...r, warehouseId, requestedAt: new Date() };
  }

  async storefrontPublishedAt(): Promise<Date | null> {
    return (await this.repo.storefrontStats()).lastAt;
  }

  /** `inventory.availability_changed.v1` → storefront sync row (newest sequence wins). */
  async applyAvailability(tx: Tx, d: AvailabilityChangedV1, at: Date) {
    await this.repo.upsertStorefront(tx, {
      variantId: d.variantId,
      publishedQty: d.availableQty,
      inStock: d.inStock,
      sequence: d.sequence,
      at,
    });
  }

  // ── internals ──

  private async views(rows: readonly AtpRow[]) {
    const [whs, names, lots, sf] = await Promise.all([
      this.deps.warehousesService.findMany([...new Set(rows.map((r) => r.warehouseId))]),
      this.deps.catalogClient.categories(),
      this.repo.topLots(rows.map((r) => ({ warehouseId: r.warehouseId, variantId: r.variantId }))),
      this.repo.storefront(rows.map((r) => r.variantId)),
    ]);
    const wh = new Map(whs.map((w) => [w.id, w]));
    const lot = new Map(lots.map((l) => [`${l.warehouseId}|${l.variantId}`, l]));
    const store = new Map(sf.map((s) => [s.variantId, s]));
    return rows.map((r) => {
      const w = wh.get(r.warehouseId);
      const l = lot.get(`${r.warehouseId}|${r.variantId}`);
      const s = store.get(r.variantId);
      const goal = r.targetStock > 0 ? r.targetStock : r.reorderLevel;
      return {
        warehouseId: r.warehouseId,
        warehouse: w === undefined ? null : { id: w.id, code: w.code, name: w.name },
        variantId: r.variantId,
        sku: r.sku,
        name: r.name,
        packLabel: r.packLabel,
        imageUrl: r.imageUrl,
        category:
          r.rootCategoryId === null
            ? null
            : { id: r.rootCategoryId, name: names?.get(r.rootCategoryId) ?? null },
        temperatureClass: r.temperatureClass,
        storageType: STORAGE[r.temperatureClass] ?? r.temperatureClass,
        zoneLabel:
          l?.zoneName == null
            ? null
            : `${l.binCode === null ? '' : `${l.binCode} • `}${l.zoneName}`,
        topLot:
          l === undefined
            ? null
            : { batchNo: l.batchNo, expiryDate: l.expiryDate?.toISOString().slice(0, 10) ?? null },
        physical: r.physical,
        openDemand: r.demand,
        allocated: r.allocated,
        pickingPacking: r.onFloor,
        safetyStock: r.safety,
        qcHold: r.qcHold,
        blocked: r.blocked,
        returned: r.returned,
        netAtp: r.netAtp,
        inbound24h: r.inbound,
        projected24h: r.projected,
        reorderLevel: r.reorderLevel,
        targetStock: r.targetStock,
        atpOfTargetPct: goal === 0 ? null : pct(r.netAtp, goal),
        health: r.health,
        healthLabel: HEALTH_LABEL[r.health],
        throttled: r.throttled,
        storefront:
          s === undefined
            ? null
            : { publishedQty: s.publishedQty, inStock: s.inStock, publishedAt: s.publishedAt },
      };
    });
  }
}
