import { NotFoundError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';
import type { Caller } from '../../middleware/guards.js';
import {
  type PageResult,
  type Paging,
  csvCell,
  decodeCursor,
  offsetOf,
  toPageResult,
} from '../../middleware/paging.js';
import type { AlertRow, MovementRow, RecordFilter, Totals } from './stock.read.repository.js';
import { OWNER_LABEL, type OwnerType, qualityStatus, zeroQty } from './stock.rules.js';

const KEY = 'inventory.view';
const KPI_TTL_SECONDS = 20;

const MOVEMENT_LABEL: Record<string, string> = {
  RECEIPT: 'Receipt',
  OPENING: 'Opening balance',
  QC_RELEASE: 'Quality release',
  QC_HOLD: 'Quality hold',
  ALLOCATE: 'Allocation',
  DEALLOCATE: 'Allocation released',
  PICK: 'Pick',
  PACK: 'Pack',
  ISSUE: 'Issue',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
  RETURN: 'Return',
  RESTOCK: 'Restock',
  ADJUSTMENT: 'Adjustment',
  DAMAGE: 'Damage',
  QUARANTINE: 'Quarantine',
  EXPIRE: 'Expired',
  WRITE_OFF: 'Write-off',
  BIN_MOVE: 'Bin move',
  OWNER_FIX: 'Ownership change',
  RELABEL: 'Relabel',
  ROLLBACK_REPLAY: 'Cutover replay',
  STATUS_CHANGE: 'Status change',
};
const IN_WAREHOUSE = new Set([
  'QC_HOLD',
  'AVAILABLE',
  'RESERVED',
  'PICKED',
  'PACKED',
  'QUARANTINED',
  'DAMAGED',
  'EXPIRED',
  'RETURNED',
]);
const QUALITY_LABEL = {
  RELEASED: 'Released',
  PARTIALLY_HOLD: 'Partially held',
  ON_HOLD: 'On hold',
  EMPTY: 'No stock',
} as const;
const QUALITY_REVIEW = {
  RELEASED: 'All units released',
  PARTIALLY_HOLD: 'Some units on hold',
  ON_HOLD: 'All units on hold',
  EMPTY: 'No units in stock',
} as const;
const CERT_LABEL: Record<string, string> = {
  NONE: 'No certificate',
  SAMPLE_REFERENCE: 'Sample reference only',
  VALID: 'Valid',
  EXPIRED: 'Expired',
  REJECTED: 'Rejected',
};
const ymd = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));
const pct = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.round((part / whole) * 1000) / 10;

/** Physical / reserved / blocked of a totals row. */
const shape = (t: Totals) => {
  const onHand =
    t.qcHold +
    t.available +
    t.reserved +
    t.picked +
    t.packed +
    t.quarantined +
    t.damaged +
    t.expired +
    t.returned;
  return {
    onHand,
    available: t.available,
    reserved: t.reserved + t.picked + t.packed,
    qcHold: t.qcHold,
    damaged: t.damaged,
    quarantined: t.quarantined,
    expired: t.expired,
    returned: t.returned,
    blocked: t.damaged + t.quarantined + t.expired,
    onHold: t.qcHold + t.quarantined + t.damaged + t.expired + t.returned,
  };
};

/**
 * W4 screen reads (D-57a Phase 2). Every widget has its own call; KPI-type answers are cached
 * 20 s in Redis (`fresh=1` bypasses). Lists are keyset paged (numbered pages ≤ 2,000 rows deep).
 */
export class StockQueries {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'stockReadRepository'
      | 'stockRepository'
      | 'warehousesService'
      | 'storageService'
      | 'catalogClient'
      | 'authClient'
      | 'mediaClient'
      | 'redis'
      | 'logger'
      | 'fulfilmentQueries'
    >,
  ) {}

  private get read() {
    return this.deps.stockReadRepository;
  }

  /** Scope of `inventory.view` (+ check one warehouse when given: 404 outside). */
  scope(caller: Caller, warehouseId?: string) {
    if (warehouseId !== undefined) caller.access.require(KEY, warehouseId);
    return caller.access.scope(KEY);
  }

  private async cached<T>(key: string, fresh: boolean, fn: () => Promise<T>): Promise<T> {
    const k = `warehouse:stock:q:${key}`;
    if (!fresh)
      try {
        const hit = await this.deps.redis.get(k);
        if (hit !== null) return JSON.parse(hit) as T;
      } catch {
        /* cache down → compute */
      }
    const value = await fn();
    try {
      await this.deps.redis.set(k, JSON.stringify(value), 'EX', KPI_TTL_SECONDS);
    } catch {
      /* best effort */
    }
    return value;
  }

  private scopeKey(caller: Caller, warehouseId?: string) {
    const s = this.scope(caller, warehouseId);
    return warehouseId ?? (s === 'ALL' ? 'ALL' : [...s].sort().join(','));
  }

  private async warehouseNames(ids: readonly string[]) {
    const rows = await this.deps.warehousesService.findMany([...new Set(ids)]);
    return new Map(rows.map((w) => [w.id, { id: w.id, code: w.code, name: w.name, type: w.type }]));
  }

  private async vendorNames(ids: readonly (string | null)[]) {
    const rows = await this.deps.stockRepository.vendorsByIds(
      ids.filter((x): x is string => x !== null),
    );
    return new Map(rows.map((v) => [v.id, { id: v.id, code: v.code, name: v.name }]));
  }

  private async binCodes(ids: readonly (string | null)[]) {
    const m = await this.deps.storageService.binLocations(
      ids.filter((x): x is string => x !== null),
    );
    return m;
  }

  private async categoryNames(): Promise<Map<string, string>> {
    return (await this.deps.catalogClient.categories()) ?? new Map();
  }

  // ── W4.00 landing ──

  landingKpis(caller: Caller, warehouseId: string | undefined, fresh: boolean) {
    return this.cached(`landing-kpis:${this.scopeKey(caller, warehouseId)}`, fresh, async () => {
      const t = shape(await this.read.totals(this.scope(caller, warehouseId), { warehouseId }));
      return {
        totalStock: t.onHand,
        available: t.available,
        reserved: t.reserved,
        onHold: t.onHold,
        unit: 'Qty',
        asOf: new Date().toISOString(),
      };
    });
  }

  landingByCategory(caller: Caller, warehouseId: string | undefined, top: number, fresh: boolean) {
    return this.cached(
      `landing-cat:${this.scopeKey(caller, warehouseId)}:${String(top)}`,
      fresh,
      async () => {
        const scope = this.scope(caller, warehouseId);
        const [rows, binRows, names, mover] = await Promise.all([
          this.read.byCategory(scope, warehouseId),
          this.read.categoryBins(scope, warehouseId),
          this.categoryNames(),
          this.read.topMover(scope, 7, warehouseId),
        ]);
        const byCat = new Map<string, number>();
        for (const r of rows)
          byCat.set(
            r.rootCategoryId ?? 'none',
            (byCat.get(r.rootCategoryId ?? 'none') ?? 0) + r.physical,
          );
        const total = [...byCat.values()].reduce((s, n) => s + n, 0);
        const sorted = [...byCat].filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1]);
        const locs = await this.binCodes(binRows.map((b) => b.binId));
        const locationOf = (cat: string) => {
          const zones = new Map<string, string[]>();
          for (const b of binRows.filter((x) => (x.rootCategoryId ?? 'none') === cat)) {
            const l = locs.get(b.binId);
            if (l === undefined) continue;
            const racks = zones.get(l.zoneName) ?? [];
            racks.push(l.rackCode);
            zones.set(l.zoneName, racks);
          }
          return [...zones]
            .map(([zone, racks]) => {
              const r = [...new Set(racks)].sort();
              return r.length === 1
                ? `Rack ${r[0] ?? ''} · ${zone}`
                : `Racks ${r[0] ?? ''}–${r.at(-1) ?? ''} · ${zone}`;
            })
            .join('; ');
        };
        const seg = (cat: string, qty: number) => ({
          rootCategoryId: cat === 'none' ? null : cat,
          name: cat === 'none' ? 'Uncategorised' : (names.get(cat) ?? 'Category'),
          qty,
          sharePct: pct(qty, total),
          locationSummary: locationOf(cat) || null,
        });
        const head = sorted.slice(0, top).map(([c, q]) => seg(c, q));
        const rest = sorted.slice(top);
        const othersQty = rest.reduce((s, [, q]) => s + q, 0);
        let topMover = null;
        if (mover !== null) {
          const [v] = await this.deps.stockRepository.variants([mover.variantId]);
          topMover = {
            variantId: mover.variantId,
            name: v?.name ?? null,
            packLabel: v?.packLabel ?? null,
            issuedUnits7d: mover.units,
          };
        }
        return {
          total,
          activeSegments: sorted.length,
          segments: head,
          others:
            othersQty > 0
              ? {
                  name: 'Others',
                  qty: othersQty,
                  sharePct: pct(othersQty, total),
                  categories: rest.length,
                }
              : null,
          topMover,
          asOf: new Date().toISOString(),
        };
      },
    );
  }

  landingStatusMix(caller: Caller, warehouseId: string | undefined, fresh: boolean) {
    return this.cached(`landing-mix:${this.scopeKey(caller, warehouseId)}`, fresh, async () => {
      const scope = this.scope(caller, warehouseId);
      const [totals, readiness] = await Promise.all([
        this.read.totals(scope, { warehouseId }),
        this.deps.fulfilmentQueries.readiness(scope, warehouseId),
      ]);
      const t = shape(totals);
      return {
        total: t.onHand,
        available: { qty: t.available, pct: pct(t.available, t.onHand) },
        reserved: { qty: t.reserved, pct: pct(t.reserved, t.onHand) },
        onHold: { qty: t.onHold, pct: pct(t.onHold, t.onHand) },
        /** % of open released demand coverable now from binned, unexpired AVAILABLE stock. */
        readiness,
        modules: { fulfilment: true },
        asOf: new Date().toISOString(),
      };
    });
  }

  async categoryMatrix(caller: Caller, fresh: boolean) {
    return this.cached(`matrix:${this.scopeKey(caller)}`, fresh, async () => {
      const rows = await this.read.byCategory(this.scope(caller));
      const [names, whs] = await Promise.all([
        this.categoryNames(),
        this.warehouseNames(rows.map((r) => r.warehouseId)),
      ]);
      const cats = new Map<string, Record<string, number>>();
      for (const r of rows) {
        const c = r.rootCategoryId ?? 'none';
        const cell = cats.get(c) ?? {};
        cell[r.warehouseId] = r.physical;
        cats.set(c, cell);
      }
      return {
        warehouses: [...whs.values()],
        rows: [...cats].map(([c, cells]) => ({
          rootCategoryId: c === 'none' ? null : c,
          name: c === 'none' ? 'Uncategorised' : (names.get(c) ?? 'Category'),
          cells,
          total: Object.values(cells).reduce((s, n) => s + n, 0),
        })),
        asOf: new Date().toISOString(),
      };
    });
  }

  async products(
    caller: Caller,
    f: {
      q?: string;
      categoryId?: string;
      brandId?: string;
      vendorId?: string;
      stockState?: string;
      warehouseId?: string;
      sort?: string;
    },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const rows = await this.read.products(scope, f, {
      limit: p.limit,
      offset: offsetOf(p),
      after: decodeCursor(p.cursor),
    });
    const names = await this.categoryNames();
    const sortVal = (r: (typeof rows)[number]) =>
      f.sort === 'available' ? r.available : f.sort === 'onHand' ? r.physical : r.name;
    return toPageResult(
      rows.map((r) => ({
        ...r,
        category:
          r.rootCategoryId === null
            ? null
            : { id: r.rootCategoryId, name: names.get(r.rootCategoryId) ?? null },
        stockState: r.available === 0 ? 'OUT' : r.available <= r.reorderLevel ? 'LOW' : 'OK',
      })),
      p,
      (r) => [sortVal(r), r.variantId],
    );
  }

  // ── W4.01 overview ──

  overviewKpis(caller: Caller, warehouseId: string | undefined, fresh: boolean) {
    return this.cached(`ov-kpis:${this.scopeKey(caller, warehouseId)}`, fresh, async () => ({
      ...shape(await this.read.totals(this.scope(caller, warehouseId), { warehouseId })),
      asOf: new Date().toISOString(),
    }));
  }

  overviewWarehouses(caller: Caller, fresh: boolean) {
    return this.cached(`ov-wh:${this.scopeKey(caller)}`, fresh, async () => {
      const rows = await this.read.byWarehouse(this.scope(caller));
      const names = await this.warehouseNames(rows.map((r) => r.warehouseId));
      const shaped = rows.map((r) => ({ warehouseId: r.warehouseId, ...shape(r) }));
      const total = shaped.reduce((s, r) => s + r.onHand, 0);
      return shaped.map((r) => ({
        warehouse: names.get(r.warehouseId) ?? {
          id: r.warehouseId,
          code: null,
          name: null,
          type: null,
        },
        onHand: r.onHand,
        available: r.available,
        reserved: r.reserved,
        sharePct: pct(r.onHand, total),
      }));
    });
  }

  overviewStatusMix(caller: Caller, warehouseId: string | undefined, fresh: boolean) {
    return this.cached(`ov-mix:${this.scopeKey(caller, warehouseId)}`, fresh, async () => {
      const t = shape(await this.read.totals(this.scope(caller, warehouseId), { warehouseId }));
      return {
        onHand: t.onHand,
        segments: [
          { key: 'AVAILABLE', label: 'Available', qty: t.available },
          { key: 'RESERVED', label: 'Reserved', qty: t.reserved },
          { key: 'QC_HOLD', label: 'QC hold', qty: t.qcHold },
          { key: 'BLOCKED', label: 'Blocked', qty: t.blocked + t.returned },
        ],
        asOf: new Date().toISOString(),
      };
    });
  }

  // ── W4.02 all stock ──

  async records(
    caller: Caller,
    f: RecordFilter & { warehouseId?: string; binCode?: string },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const filter = await this.withBinFilter(scope, f);
    const [rows, total] = await Promise.all([
      this.read.records(scope, filter, {
        limit: p.limit,
        offset: offsetOf(p),
        after: decodeCursor(p.cursor),
      }),
      this.read.recordsCount(scope, filter),
    ]);
    const page = toPageResult(
      rows,
      p,
      (r) => [r.sortKey instanceof Date ? r.sortKey.toISOString() : r.sortKey, r.positionId],
      total,
    );
    return { ...page, items: await this.recordViews(page.items) };
  }

  private async withBinFilter(
    scope: ReturnType<StockQueries['scope']>,
    f: RecordFilter & { binCode?: string },
  ) {
    if (f.q === undefined && f.binCode === undefined) return f;
    const code = f.binCode ?? f.q ?? '';
    const bins = await this.deps.storageService.binsByCode(scope, code, 50);
    if (f.binCode !== undefined) return { ...f, binIds: bins.map((b) => b.id) };
    return bins.length > 0 ? { ...f, binIds: bins.map((b) => b.id) } : f;
  }

  private async recordViews(rows: Awaited<ReturnType<StockQueries['read']['records']>>) {
    const [whs, vendors, bins] = await Promise.all([
      this.warehouseNames(rows.map((r) => r.warehouseId)),
      this.vendorNames(rows.flatMap((r) => [r.vendorId, r.batchVendorId])),
      this.binCodes(rows.map((r) => r.binId)),
    ]);
    return rows.map((r) => {
      const vendorId = r.vendorId ?? r.batchVendorId;
      return {
        positionId: r.positionId,
        product: {
          variantId: r.variantId,
          sku: r.sku,
          name: r.name,
          packLabel: r.packLabel,
          imageUrl: r.imageUrl,
        },
        brand: r.brandName,
        vendor:
          vendorId === null
            ? null
            : (vendors.get(vendorId) ?? { id: vendorId, code: null, name: null }),
        warehouse: whs.get(r.warehouseId) ?? {
          id: r.warehouseId,
          code: null,
          name: null,
          type: null,
        },
        batch: {
          id: r.batchId,
          batchNo: r.batchNo,
          mfgDate: ymd(r.mfgDate),
          isOpening: r.isOpening,
        },
        bin: r.binId === null ? null : { id: r.binId, code: bins.get(r.binId)?.binCode ?? null },
        onHand: r.onHand,
        available: r.available,
        reserved: r.reserved,
        qcHold: r.qcHold,
        quarantined: r.quarantined,
        damaged: r.damaged,
        expiryDate: ymd(r.expiryDate),
        receivedAt: r.receivedAt,
        ownerType: r.ownerType,
        ownership: OWNER_LABEL[r.ownerType as OwnerType],
        reviewFields: r.reviewFields,
      };
    });
  }

  /** CSV of the All Stock list (same filters), streamed in pages of 1,000. */
  async *recordsCsv(caller: Caller, f: RecordFilter & { warehouseId?: string; binCode?: string }) {
    const scope = this.scope(caller, f.warehouseId);
    const filter = await this.withBinFilter(scope, f);
    yield 'Product,SKU,Brand,Vendor,Warehouse,Batch,Bin,On hand,Available,Reserved,QC hold,Quarantined,Damaged,Expiry,Ownership\n';
    let after: readonly unknown[] | null = null;
    for (let i = 0; i < 100; i += 1) {
      const rows = await this.read.records(scope, filter, { limit: 1000, offset: null, after });
      const views = await this.recordViews(rows.slice(0, 1000));
      for (const v of views)
        yield `${[v.product.name, v.product.sku, v.brand, v.vendor?.name, v.warehouse.name, v.batch.batchNo, v.bin?.code, v.onHand, v.available, v.reserved, v.qcHold, v.quarantined, v.damaged, v.expiryDate, v.ownership].map(csvCell).join(',')}\n`;
      if (rows.length <= 1000) return;
      const last = rows[999];
      if (last === undefined) return;
      after = [
        last.sortKey instanceof Date ? last.sortKey.toISOString() : last.sortKey,
        last.positionId,
      ];
    }
  }

  /** Header search hits from stock (SKU, batch, unit QR, CN / RT, RST, TR); empty without access. */
  async search(caller: Caller, q: string, limit = 5) {
    const scope = caller.access.scope('inventory.view');
    if (scope !== 'ALL' && scope.length === 0) return [];
    return this.deps.stockReadRepository.search(scope, q.trim(), limit);
  }

  async filterOptions(
    caller: Caller,
    field: string,
    q: string | undefined,
    warehouseId: string | undefined,
  ) {
    const scope = this.scope(caller, warehouseId);
    switch (field) {
      case 'brand':
        return (await this.read.brands(scope, q, 50)).map((b) => ({ id: b.id, name: b.name }));
      case 'category': {
        const [ids, names] = await Promise.all([
          this.read.categoriesInStock(scope),
          this.categoryNames(),
        ]);
        return ids
          .map((r) => ({ id: r.id, name: names.get(r.id) ?? null }))
          .filter((c) => q === undefined || (c.name ?? '').toLowerCase().includes(q.toLowerCase()))
          .slice(0, 100);
      }
      case 'vendor':
        return (
          await this.deps.stockRepository.vendors({
            ...(q === undefined ? {} : { q }),
            status: 'ACTIVE',
            limit: 50,
          })
        ).map((v) => ({ id: v.id, name: v.name, code: v.code }));
      case 'batch':
        return this.read.batchNos(scope, q, 50);
      default:
        return (await this.deps.storageService.binsByCode(scope, q ?? '', 50)).map((b) => ({
          id: b.id,
          name: b.code,
          warehouseId: b.warehouseId,
        }));
    }
  }

  // ── W4.03 product ──

  async productHeader(caller: Caller, variantId: string) {
    this.scope(caller);
    const [v] = await this.deps.stockRepository.variants([variantId]);
    if (v === undefined) throw new NotFoundError('Product');
    const [supply, names] = await Promise.all([
      this.deps.stockRepository.vendorSupply([variantId]),
      this.categoryNames(),
    ]);
    const preferred = supply.find((s) => s.isPreferred) ?? supply[0];
    const vendor =
      preferred === undefined
        ? null
        : ((await this.vendorNames([preferred.vendorId])).get(preferred.vendorId) ?? null);
    return {
      variantId: v.variantId,
      productId: v.productId,
      sku: v.sku,
      name: v.name,
      variantName: v.variantName,
      packLabel: v.packLabel,
      imageUrl: v.imageUrl,
      brand: { id: v.brandId, name: v.brandName },
      category: {
        id: v.categoryId,
        name: names.get(v.categoryId) ?? names.get(v.rootCategoryId ?? '') ?? null,
      },
      vendor,
      ownershipModel: preferred?.ownershipModel ?? null,
      temperatureClass: v.temperatureClass,
      weightGrams: v.weightGrams,
      shelfLifeMonths: v.shelfLifeMonths,
      isActive: v.isActive,
    };
  }

  async productKpis(caller: Caller, variantId: string, warehouseId?: string) {
    return {
      ...shape(await this.read.totals(this.scope(caller, warehouseId), { warehouseId, variantId })),
      asOf: new Date().toISOString(),
    };
  }

  async productWarehouses(caller: Caller, variantId: string) {
    const rows = await this.read.byWarehouse(this.scope(caller), variantId);
    const names = await this.warehouseNames(rows.map((r) => r.warehouseId));
    return rows.map((r) => {
      const t = shape(r);
      return {
        warehouse: names.get(r.warehouseId) ?? {
          id: r.warehouseId,
          code: null,
          name: null,
          type: null,
        },
        onHand: t.onHand,
        available: t.available,
        reserved: t.reserved,
        qcHold: t.qcHold,
        blocked: t.blocked,
      };
    });
  }

  async productBatches(caller: Caller, variantId: string, warehouseId?: string) {
    const rows = await this.read.batchesOfVariant(
      variantId,
      this.scope(caller, warehouseId),
      warehouseId,
    );
    const [names, bins] = await Promise.all([
      this.warehouseNames(rows.map((r) => r.warehouseId)),
      this.binCodes(rows.flatMap((r) => r.binIds)),
    ]);
    return rows.map((r) => ({
      batchId: r.batchId,
      batchNo: r.batchNo,
      isOpening: r.isOpening,
      warehouse: names.get(r.warehouseId) ?? {
        id: r.warehouseId,
        code: null,
        name: null,
        type: null,
      },
      mfgDate: ymd(r.mfgDate),
      expiryDate: ymd(r.expiryDate),
      bin:
        r.binIds[0] === null || r.binIds[0] === undefined
          ? null
          : { id: r.binIds[0], code: bins.get(r.binIds[0])?.binCode ?? null },
      bins: r.binIds.flatMap((b) =>
        b === null ? [] : [{ id: b, code: bins.get(b)?.binCode ?? null }],
      ),
      onHand: r.physical,
      available: r.available,
      reserved: r.reserved,
    }));
  }

  async productAvailability(caller: Caller, variantId: string, warehouseId?: string) {
    const scope = this.scope(caller, warehouseId);
    const t = shape(await this.read.totals(scope, { warehouseId, variantId }));
    return {
      available: t.available,
      reserved: t.reserved,
      qcHold: t.qcHold,
      damagedQuarantined: t.damaged + t.quarantined,
      expired: t.expired,
      policy: {
        code: 'RELEASED_ONLY',
        text: 'Only released stock is available for customer orders.',
      },
      asOf: new Date().toISOString(),
    };
  }

  // ── units ──

  async units(
    caller: Caller,
    f: {
      batchId?: string;
      variantId?: string;
      warehouseId?: string;
      status?: string;
      binId?: string;
    },
    p: Paging,
  ): Promise<PageResult<unknown>> {
    const scope = this.scope(caller, f.warehouseId);
    const rows = await this.read.units(f, scope, {
      limit: p.limit,
      afterSeq: decodeCursor(p.cursor),
    });
    const page = toPageResult(rows, { ...p, page: undefined }, (r) => [r.batchId, r.seq]);
    const bins = await this.binCodes(page.items.map((u) => u.binId));
    return {
      ...page,
      items: page.items.map((u) => ({
        qrCode: u.qrCode,
        batchId: u.batchId,
        batchNo: u.batchNo,
        variantId: u.variantId,
        warehouseId: u.warehouseId,
        bin: u.binId === null ? null : { id: u.binId, code: bins.get(u.binId)?.binCode ?? null },
        status: u.status,
        statusLabel: u.status
          .replaceAll('_', ' ')
          .toLowerCase()
          .replace(/^\w/, (c) => c.toUpperCase()),
        seq: u.seq,
        ownerType: u.ownerType,
        lastEventAt: u.lastEventAt,
      })),
    };
  }

  async unit(caller: Caller, qrCode: string) {
    const u = await this.read.unit(qrCode);
    if (u === null) throw new NotFoundError('Unit');
    if (u.warehouseId !== null) caller.access.require(KEY, u.warehouseId);
    const [batch, variants, bins] = await Promise.all([
      this.deps.stockRepository.batch(u.batchId),
      this.deps.stockRepository.variants([u.variantId]),
      this.binCodes([u.binId]),
    ]);
    return {
      qrCode: u.qrCode,
      status: u.status,
      seq: u.seq,
      ownerType: u.ownerType,
      ownership: OWNER_LABEL[u.ownerType],
      warehouseId: u.warehouseId,
      bin: u.binId === null ? null : { id: u.binId, code: bins.get(u.binId)?.binCode ?? null },
      batch:
        batch === null
          ? null
          : {
              id: batch.id,
              batchNo: batch.batchNo,
              expiryDate: ymd(batch.expiryDate),
              mfgDate: ymd(batch.mfgDate),
            },
      product:
        variants[0] === undefined
          ? null
          : { variantId: variants[0].variantId, sku: variants[0].sku, name: variants[0].name },
      shipmentId: u.shipmentId,
      generatedAt: u.generatedAt,
      lastEventAt: u.lastEventAt,
    };
  }

  // ── W4.04 batch ──

  private async batchOr404(batchId: string) {
    const b = await this.deps.stockRepository.batch(batchId);
    if (b === null) throw new NotFoundError('Batch');
    return b;
  }

  async batchHeader(caller: Caller, batchId: string, warehouseId?: string) {
    const scope = this.scope(caller, warehouseId);
    const b = await this.batchOr404(batchId);
    const [positions, receipts, variants] = await Promise.all([
      this.read.positionsOfBatch(batchId, scope, warehouseId),
      this.read.receiptsOfBatch(batchId, warehouseId),
      this.deps.stockRepository.variants([b.variantId]),
    ]);
    if (positions.length === 0 && warehouseId !== undefined) throw new NotFoundError('Batch');
    const q = zeroQty();
    const binQty = new Map<string | null, number>();
    const owners = new Set<string>();
    for (const p of positions) {
      for (const k of Object.keys(q) as (keyof typeof q)[]) q[k] += p[k];
      const phys =
        p.qcHold +
        p.available +
        p.reserved +
        p.picked +
        p.packed +
        p.quarantined +
        p.damaged +
        p.expired +
        p.returned;
      binQty.set(p.binId, (binQty.get(p.binId) ?? 0) + phys);
      if (phys > 0) owners.add(p.ownerType);
    }
    const whIds = [...new Set(positions.map((p) => p.warehouseId))];
    const [whs, bins, vendors] = await Promise.all([
      this.warehouseNames(whIds),
      this.binCodes([...binQty.keys()]),
      this.vendorNames([b.vendorId]),
    ]);
    const binList = [...binQty]
      .filter(([, n]) => n > 0)
      .sort((a, b2) => b2[1] - a[1])
      .map(([id, qty]) => ({
        id,
        code: id === null ? null : (bins.get(id)?.binCode ?? null),
        qty,
      }));
    const quality = qualityStatus(q);
    const owner = owners.size === 1 ? ([...owners][0] as OwnerType) : null;
    const v = variants[0];
    return {
      batchId: b.id,
      batchNo: b.batchNo,
      title: `${v?.name ?? 'Product'} · ${b.batchNo}`,
      product:
        v === undefined
          ? null
          : {
              variantId: v.variantId,
              sku: v.sku,
              name: v.name,
              packLabel: v.packLabel,
              imageUrl: v.imageUrl,
            },
      consignmentNo: receipts[0]?.cnNo ?? null,
      warehouses: whIds.map((id) => whs.get(id) ?? { id, code: null, name: null, type: null }),
      mfgDate: ymd(b.mfgDate),
      expiryDate: ymd(b.expiryDate),
      bin: binList[0] ?? null,
      bins: binList,
      ownerType: owner ?? 'MIXED',
      ownership: owner === null ? 'Mixed ownership' : OWNER_LABEL[owner],
      vendor: b.vendorId === null ? null : (vendors.get(b.vendorId) ?? null),
      qualityStatus: quality,
      qualityLabel: QUALITY_LABEL[quality],
      unitOfMeasure: 'Packs',
      serialized: b.serialized,
      isOpening: b.isOpening,
    };
  }

  async batchKpis(caller: Caller, batchId: string, warehouseId?: string) {
    await this.batchOr404(batchId);
    return {
      ...shape(await this.read.batchTotals(batchId, this.scope(caller, warehouseId), warehouseId)),
      asOf: new Date().toISOString(),
    };
  }

  async batchTraceability(caller: Caller, batchId: string, warehouseId?: string) {
    const header = await this.batchHeader(caller, batchId, warehouseId);
    const kpis = shape(
      await this.read.batchTotals(batchId, this.scope(caller, warehouseId), warehouseId),
    );
    const [receipts, issues] = await Promise.all([
      this.read.receiptsOfBatch(batchId, warehouseId),
      this.read.movements(
        this.scope(caller, warehouseId),
        {
          batchId,
          types: ['ISSUE', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN'],
          ...(warehouseId === undefined ? {} : { warehouseId }),
        },
        { limit: 50, offset: null, after: null },
      ),
    ]);
    return {
      sku: header.product?.sku ?? null,
      product: header.product?.name ?? null,
      warehouses: header.warehouses,
      batchNo: header.batchNo,
      bin: header.bin,
      available: kpis.available,
      reserved: kpis.reserved,
      ownership: header.ownership,
      receipts: receipts.map((r) => ({
        cnNo: r.cnNo,
        receiptId: r.receiptId,
        warehouseId: r.warehouseId,
        qty: r.qty,
        receivedAt: r.receivedAt,
        sourceType: r.sourceType,
      })),
      bins: header.bins,
      outbound: issues.slice(0, 50).map((m) => ({
        type: m.type,
        label: MOVEMENT_LABEL[m.type] ?? m.type,
        qty: m.qty,
        refNo: m.refNo,
        at: m.createdAt,
      })),
    };
  }

  async batchQuality(caller: Caller, batchId: string, warehouseId?: string) {
    const b = await this.batchOr404(batchId);
    const scope = this.scope(caller, warehouseId);
    const q = shape(await this.read.batchTotals(batchId, scope, warehouseId));
    const status = qualityStatus({
      ...zeroQty(),
      qcHold: q.qcHold,
      quarantined: q.quarantined,
      available: q.onHand - q.qcHold - q.quarantined,
    });
    const urls =
      b.coaMediaKey === null ? {} : await this.deps.mediaClient.signRead([b.coaMediaKey]);
    return {
      coaRef: b.coaRef,
      certificateStatus: b.certificateStatus,
      certificateLabel: CERT_LABEL[b.certificateStatus] ?? b.certificateStatus,
      qualityReview: QUALITY_REVIEW[status],
      qualityStatus: status,
      qualityNote: b.qualityNote,
      documentUrl: b.coaMediaKey === null ? null : (urls[b.coaMediaKey] ?? null),
      note: 'The live certificate must come from the approved quality system.',
    };
  }

  // ── W4.09 movements ──

  async movements(
    caller: Caller,
    f: {
      type?: string;
      warehouseId?: string;
      variantId?: string;
      batchId?: string;
      refNo?: string;
      from?: string;
      to?: string;
    },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const rows = await this.read.movements(scope, f, {
      limit: p.limit,
      offset: offsetOf(p),
      after: decodeCursor(p.cursor),
    });
    const page = toPageResult(rows, p, (r) => [r.createdAt.toISOString(), r.id]);
    return { ...page, items: await this.movementViews(page.items) };
  }

  private async movementViews(rows: MovementRow[]) {
    const whs = await this.warehouseNames(rows.map((r) => r.warehouseId));
    return rows.map((m) => {
      const signed =
        (m.toStatus !== null && IN_WAREHOUSE.has(m.toStatus) ? m.qty : 0) -
        (m.fromStatus !== null && IN_WAREHOUSE.has(m.fromStatus) ? m.qty : 0);
      return {
        id: m.id,
        at: m.createdAt,
        type: m.type,
        movement: MOVEMENT_LABEL[m.type] ?? m.type,
        sku: m.sku,
        product: m.name,
        variantId: m.variantId,
        batchId: m.batchId,
        batchNo: m.batchNo,
        warehouse: whs.get(m.warehouseId) ?? {
          id: m.warehouseId,
          code: null,
          name: null,
          type: null,
        },
        quantity: signed === 0 ? m.qty : signed,
        signed: signed !== 0,
        fromStatus: m.fromStatus,
        toStatus: m.toStatus,
        reference: m.refNo,
        refType: m.refType,
        refId: m.refId,
      };
    });
  }

  async movement(caller: Caller, id: string) {
    const m = await this.read.movement(id);
    if (m === null) throw new NotFoundError('Movement');
    caller.access.require(KEY, m.warehouseId);
    const [variants, batch, bins, people] = await Promise.all([
      this.deps.stockRepository.variants([m.variantId]),
      this.deps.stockRepository.batch(m.batchId),
      this.binCodes([m.binId]),
      this.deps.authClient.contacts(m.actorUserId === null ? [] : [m.actorUserId]),
    ]);
    const [view] = await this.movementViews([
      {
        ...m,
        type: m.type,
        fromStatus: m.fromStatus,
        toStatus: m.toStatus,
        ownerType: m.ownerType,
        sku: variants[0]?.sku ?? null,
        name: variants[0]?.name ?? null,
        batchNo: batch?.batchNo ?? null,
      },
    ]);
    return {
      ...view,
      bin: m.binId === null ? null : { id: m.binId, code: bins.get(m.binId)?.binCode ?? null },
      ownerType: m.ownerType,
      sellableDelta: m.sellableDelta,
      damagedDelta: m.damagedDelta,
      reason: m.reason,
      actor:
        m.actorUserId === null
          ? { id: null, name: 'System' }
          : { id: m.actorUserId, name: people.get(m.actorUserId)?.fullName ?? null },
      requestId: m.requestId,
    };
  }

  async *movementsCsv(
    caller: Caller,
    f: {
      type?: string;
      warehouseId?: string;
      variantId?: string;
      batchId?: string;
      from?: string;
      to?: string;
    },
  ) {
    const scope = this.scope(caller, f.warehouseId);
    yield 'Date & time,Movement,SKU,Product,Batch,Warehouse,Quantity,Reference\n';
    let after: readonly unknown[] | null = null;
    for (let i = 0; i < 200; i += 1) {
      const rows = await this.read.movements(scope, f, { limit: 1000, offset: null, after });
      for (const v of await this.movementViews(rows.slice(0, 1000)))
        yield `${[v.at, v.movement, v.sku, v.product, v.batchNo, v.warehouse.name, v.quantity, v.reference].map(csvCell).join(',')}\n`;
      if (rows.length <= 1000) return;
      const last = rows[999];
      if (last === undefined) return;
      after = [last.createdAt.toISOString(), last.id];
    }
  }

  // ── W4.10 ownership ──

  ownershipKpis(caller: Caller, warehouseId: string | undefined, fresh: boolean) {
    return this.cached(`own:${this.scopeKey(caller, warehouseId)}`, fresh, async () => {
      const rows = await this.read.ownershipTotals(this.scope(caller, warehouseId), warehouseId);
      const of = (k: string) => rows.find((r) => r.ownerType === k)?.physical ?? 0;
      return {
        SOR: { label: OWNER_LABEL.SOR, onHand: of('SOR') },
        FARMX: { label: OWNER_LABEL.FARMX, onHand: of('FARMX') },
        JIT: { label: OWNER_LABEL.JIT, onHand: of('JIT') },
        unit: 'On-hand packs',
        note: 'Legal title and settlement triggers require client confirmation. Ownership is recorded per stock record.',
        asOf: new Date().toISOString(),
      };
    });
  }

  async ownership(
    caller: Caller,
    f: { model?: string; vendorId?: string; q?: string; warehouseId?: string },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const rows = await this.read.ownership(scope, f, {
      limit: p.limit,
      offset: offsetOf(p),
      after: decodeCursor(p.cursor),
    });
    const page = toPageResult(rows, p, (r) => [r.name, r.warehouseId, r.ownerType, r.variantId]);
    const [whs, vendors] = await Promise.all([
      this.warehouseNames(page.items.map((r) => r.warehouseId)),
      this.vendorNames(page.items.map((r) => r.vendorId)),
    ]);
    return {
      ...page,
      items: page.items.map((r) => ({
        product: { variantId: r.variantId, sku: r.sku, name: r.name },
        vendor: r.vendorId === null ? null : (vendors.get(r.vendorId) ?? null),
        warehouse: whs.get(r.warehouseId) ?? {
          id: r.warehouseId,
          code: null,
          name: null,
          type: null,
        },
        ownerType: r.ownerType,
        ownership: OWNER_LABEL[r.ownerType as OwnerType],
        onHand: r.physical,
        available: r.available,
        batchId: r.topBatchId,
      })),
    };
  }

  // ── W4.06 alerts / W4.07 plan ──

  alertKpis(caller: Caller, warehouseId: string | undefined, fresh: boolean) {
    return this.cached(`alert-kpis:${this.scopeKey(caller, warehouseId)}`, fresh, async () => {
      const c = await this.read.alertCounts(this.scope(caller, warehouseId), warehouseId);
      return {
        lowStock: c.low,
        lowStockLabel: 'At or below the minimum',
        outOfStock: c.out,
        outOfStockLabel: 'No sellable stock',
        suggestedRestock: c.suggested,
        suggestedLabel: 'Packs · target minus available',
        asOf: new Date().toISOString(),
      };
    });
  }

  async alertCount(caller: Caller, warehouseId?: string) {
    const c = await this.read.alertCounts(this.scope(caller, warehouseId), warehouseId);
    return { count: c.low + c.out, low: c.low, out: c.out };
  }

  async alerts(
    caller: Caller,
    f: {
      type?: 'all' | 'low' | 'out' | 'plan';
      warehouseId?: string;
      q?: string;
      vendorId?: string;
      brandId?: string;
    },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const rows = await this.read.alerts(scope, f, {
      limit: p.limit,
      offset: offsetOf(p),
      after: decodeCursor(p.cursor),
    });
    const page = toPageResult(rows, p, (r) => [r.available, r.warehouseId, r.variantId]);
    return { ...page, items: await this.alertViews(page.items) };
  }

  private async alertViews(rows: AlertRow[]) {
    const [whs, vendors] = await Promise.all([
      this.warehouseNames(rows.map((r) => r.warehouseId)),
      this.vendorNames(rows.map((r) => r.vendorId)),
    ]);
    return rows.map((r) => {
      const target = r.targetStock > 0 ? r.targetStock : r.reorderLevel;
      return {
        product: { variantId: r.variantId, sku: r.sku, name: r.name },
        brand: r.brandName,
        vendor: r.vendorId === null ? null : (vendors.get(r.vendorId) ?? null),
        warehouse: whs.get(r.warehouseId) ?? {
          id: r.warehouseId,
          code: null,
          name: null,
          type: null,
        },
        available: r.available,
        minimum: r.reorderLevel,
        target: r.targetStock,
        safetyStock: r.safetyStock,
        inbound: r.inbound,
        levelPct: target <= 0 ? null : Math.min(100, pct(r.available, target)),
        suggested: r.suggested,
        state: r.state,
      };
    });
  }

  async restockPlan(
    caller: Caller,
    f: { month?: string; warehouseId?: string; vendorId?: string; brandId?: string; q?: string },
    p: Paging,
  ) {
    const page = await this.alerts(caller, { ...f, type: 'plan' }, p);
    return {
      ...page,
      month: f.month ?? new Date().toISOString().slice(0, 7),
      note: 'Suggested = target stock − available − open inbound. Review demand before approval.',
    };
  }

  async restockPlanItem(caller: Caller, variantId: string, warehouseId: string) {
    caller.access.require(KEY, warehouseId);
    const [alert] = (
      await this.read.alerts(
        this.scope(caller, warehouseId),
        { type: 'plan', warehouseId },
        { limit: 500, offset: null, after: null },
      )
    ).filter((a) => a.variantId === variantId);
    const [issued, supply, t] = await Promise.all([
      this.read.issuedByMonth(warehouseId, variantId, 3),
      this.deps.stockRepository.vendorSupply([variantId]),
      this.read.totals(this.scope(caller, warehouseId), { warehouseId, variantId }),
    ]);
    const preferred = supply.find((s) => s.isPreferred) ?? supply[0];
    return {
      variantId,
      warehouseId,
      available: t.available,
      target: alert?.targetStock ?? 0,
      minimum: alert?.reorderLevel ?? 0,
      inbound: alert?.inbound ?? 0,
      suggested: alert?.suggested ?? 0,
      issuedLast3Months: issued,
      avgMonthlyIssue:
        issued.length === 0
          ? 0
          : Math.round(issued.reduce((s, r) => s + r.units, 0) / issued.length),
      leadTimeDays: preferred?.leadTimeDays ?? null,
      preferredVendorId: preferred?.vendorId ?? null,
    };
  }

  async reservedBatches(caller: Caller, warehouseId?: string) {
    return this.read.reservedBatchCount(this.scope(caller, warehouseId), warehouseId);
  }
}
