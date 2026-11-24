import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';
export interface BinLocation {
  binId: string;
  binCode: string;
  warehouseId: string;
  zoneId: string;
  rackCode: string;
  zoneCode: string;
  zoneName: string;
  temperatureClass: string;
  isFoodGrade: boolean;
  /** Secure / vault zone (restricted SKUs). */
  isSecure: boolean;
}

import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import type { Actor, AuditEntry } from '../audit/index.js';
import type { BinRow, RackRow, ZoneRow } from './storage.repository.js';
import type {
  BinLimits,
  BinUpdate,
  BinView,
  BinsInput,
  LayoutView,
  RackInput,
  RackUpdate,
  RackView,
  ZoneInput,
  ZoneUpdate,
  ZoneView,
} from './storage.types.js';

/** At most this many bins in one request. */
export const MAX_BINS_PER_CALL = 200;
const EPS = 1e-6;

const actorOf = (c: Caller): Actor => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });
const fixed = (n: number, digits: number) => n.toFixed(digits);
const pct = (part: number, whole: number) =>
  whole <= 0 ? 0 : Math.round((part / whole) * 1000) / 10;

const versionConflict = (current: number) =>
  new ConflictError('Changed by someone else; reload and retry', {
    details: { reason: 'VERSION_CONFLICT', currentVersion: current },
  });
const notEmpty = (what: string) =>
  new ConflictError(`Remove its ${what} first`, { details: { reason: 'NOT_EMPTY' } });
const duplicate = (what: string, code: string) =>
  new ConflictError(`${what} code ${code} is already used in this warehouse`, {
    details: { reason: 'DUPLICATE_CODE' },
  });
const overCapacity = (rack: string, weight: number, volume: number) =>
  new ConflictError(
    `Bins would exceed rack ${rack}: ${fixed(weight, 2)} kg / ${fixed(volume, 3)} m³ left`,
    {
      details: {
        reason: 'RACK_CAPACITY_EXCEEDED',
        availableWeightKg: fixed(weight, 2),
        availableVolumeM3: fixed(volume, 3),
      },
    },
  );

/** Next free `<prefix>-NN` codes (01, 02, …) after the highest one in use. */
export function nextCodes(prefix: string, used: readonly string[], count: number): string[] {
  const pattern = new RegExp(`^${prefix.replace(/[-_]/g, '\\$&')}-(\\d+)$`);
  let max = 0;
  for (const code of used) {
    const n = Number(pattern.exec(code)?.[1] ?? '0');
    if (n > max) max = n;
  }
  return Array.from(
    { length: count },
    (_, i) => `${prefix}-${String(max + i + 1).padStart(2, '0')}`,
  );
}

const zoneView = (z: ZoneRow, counts?: { racks: number; bins: number }): ZoneView => ({
  id: z.id,
  code: z.code,
  name: z.name,
  temperatureClass: z.temperatureClass,
  minTempC: z.minTempC?.toFixed(1) ?? null,
  maxTempC: z.maxTempC?.toFixed(1) ?? null,
  isSecure: z.isSecure,
  isFoodGrade: z.isFoodGrade,
  productCategoryIds: z.productCategoryIds,
  status: z.status,
  sortOrder: z.sortOrder,
  version: z.version,
  rackCount: counts?.racks ?? 0,
  binCount: counts?.bins ?? 0,
});

const rackView = (
  r: RackRow,
  alloc?: { weight: number; volume: number; bins: number },
): RackView => {
  const weight = num(r.maxWeightKg);
  const volume = num(r.volumeM3);
  const freeVolume = volume - (alloc?.volume ?? 0);
  return {
    id: r.id,
    zoneId: r.zoneId,
    zoneCode: r.zone.code,
    code: r.code,
    maxWeightKg: fixed(weight, 2),
    volumeM3: fixed(volume, 3),
    binCount: alloc?.bins ?? 0,
    availableWeightKg: fixed(weight - (alloc?.weight ?? 0), 2),
    availableVolumeM3: fixed(freeVolume, 3),
    availablePct: pct(freeVolume, volume),
    status: r.status,
    version: r.version,
  };
};

const binView = (b: BinRow): BinView => {
  const volume = num(b.volumeM3);
  const free = volume - num(b.usedVolumeM3);
  return {
    id: b.id,
    code: b.code,
    zoneId: b.zoneId,
    zoneCode: b.rack.zone.code,
    rackId: b.rackId,
    rackCode: b.rack.code,
    temperatureClass: b.rack.zone.temperatureClass,
    maxWeightKg: fixed(num(b.maxWeightKg), 2),
    volumeM3: fixed(volume, 3),
    usedWeightKg: fixed(num(b.usedWeightKg), 2),
    usedVolumeM3: fixed(num(b.usedVolumeM3), 3),
    availableVolumeM3: fixed(free, 3),
    availablePct: pct(free, volume),
    status: b.status,
  };
};

/**
 * Storage setup (W2.05 / wizard step 3, D-56): zones → racks → bins. Bin limits never add up to
 * more than their rack's (checked under the rack row lock). Occupancy arrives with put-away (W8).
 */
export class StorageService {
  private readonly repo: Cradle['storageRepository'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly auditService: Cradle['auditService'];
  private readonly lazy: Pick<Cradle, 'warehousesService'>;

  constructor(
    deps: Pick<
      Cradle,
      'storageRepository' | 'runInTransaction' | 'auditService' | 'warehousesService'
    >,
  ) {
    this.repo = deps.storageRepository;
    this.runInTransaction = deps.runInTransaction;
    this.auditService = deps.auditService;
    this.lazy = deps;
  }

  // ── Reads ──

  async layout(caller: Caller, warehouseId: string): Promise<LayoutView> {
    await this.visible(caller, warehouseId, 'warehouse.view');
    return { warehouseId, zones: await this.repo.layout(warehouseId) };
  }

  async zones(caller: Caller, warehouseId: string): Promise<ZoneView[]> {
    await this.visible(caller, warehouseId, 'warehouse.view');
    const [zones, counts] = await Promise.all([
      this.repo.zones(warehouseId),
      this.repo.zoneCounts(warehouseId),
    ]);
    return zones.map((z) => zoneView(z, counts.get(z.id)));
  }

  async racks(caller: Caller, warehouseId: string, zoneId?: string): Promise<RackView[]> {
    await this.visible(caller, warehouseId, 'warehouse.view');
    const racks = await this.repo.racks(warehouseId, zoneId);
    const alloc = await this.repo.allocated(racks.map((r) => r.id));
    return racks.map((r) => rackView(r, alloc.get(r.id)));
  }

  async bins(
    caller: Caller,
    warehouseId: string,
    filter: { rackId?: string; zoneId?: string; cursor?: string; limit: number },
  ): Promise<{ items: BinView[]; nextCursor: string | null; limit: number }> {
    await this.visible(caller, warehouseId, 'warehouse.view');
    const rows = await this.repo.bins(warehouseId, filter);
    const items = rows.slice(0, filter.limit).map(binView);
    return {
      items,
      nextCursor: rows.length > filter.limit ? (items.at(-1)?.code ?? null) : null,
      limit: filter.limit,
    };
  }

  /** Bin code / status / warehouse by id (D-57 stock positions; no caller check). */
  async binFacts(
    ids: readonly string[],
    tx?: Tx,
  ): Promise<Map<string, { id: string; warehouseId: string; code: string; status: string }>> {
    if (ids.length === 0) return new Map();
    return new Map((await this.repo.binFacts(ids, tx)).map((b) => [b.id, b]));
  }

  /** Bin labels for stock screens: bin code, rack code, zone code / name / temperature class. */
  async binLocations(ids: readonly string[]): Promise<Map<string, BinLocation>> {
    if (ids.length === 0) return new Map();
    const rows = await this.repo.binLocations(ids);
    return new Map(
      rows.map((b) => [
        b.id,
        {
          binId: b.id,
          binCode: b.code,
          warehouseId: b.warehouseId,
          zoneId: b.zoneId,
          rackCode: b.rack.code,
          zoneCode: b.rack.zone.code,
          zoneName: b.rack.zone.name,
          temperatureClass: b.rack.zone.temperatureClass,
          isFoodGrade: b.rack.zone.isFoodGrade,
          isSecure: b.rack.zone.isSecure,
        },
      ]),
    );
  }

  binsByCode(warehouseIds: readonly string[] | 'ALL', q: string, limit: number) {
    return this.repo.binsByCode(warehouseIds, q, limit);
  }

  /** Bin id by code in one warehouse (filters). */
  async binByCode(warehouseId: string, code: string): Promise<string | null> {
    return (await this.repo.binIdByCode(warehouseId, code))?.id ?? null;
  }

  /** ACTIVE zones per warehouse (setup checklist). */
  activeZoneCounts(warehouseIds: readonly string[], tx?: Tx): Promise<Map<string, number>> {
    return this.repo.activeZoneCounts(warehouseIds, tx);
  }

  /** Zone facts for storage rules (ids, codes, temperature, food grade, categories). */
  zoneIndex(warehouseId: string) {
    return this.repo.zoneIndex(warehouseId);
  }

  searchCodes(warehouseIds: readonly string[] | 'ALL', q: string, limit: number) {
    return this.repo.searchCodes(warehouseIds, q, limit);
  }

  // ── Zones ──

  async createZone(caller: Caller, warehouseId: string, input: ZoneInput): Promise<ZoneView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    this.assertTemps(input.minTempC, input.maxTempC);
    return this.runInTransaction(async (tx) => {
      if ((await this.repo.zones(warehouseId)).some((z) => z.code === input.code))
        throw duplicate('Zone', input.code);
      const z = await this.repo.createZone(tx, {
        warehouseId,
        code: input.code,
        name: input.name,
        temperatureClass: input.temperatureClass,
        minTempC: input.minTempC ?? null,
        maxTempC: input.maxTempC ?? null,
        isSecure: input.isSecure ?? false,
        isFoodGrade: input.isFoodGrade ?? false,
        productCategoryIds: [...new Set(input.productCategoryIds ?? [])],
        status: input.status ?? 'ACTIVE',
        sortOrder: input.sortOrder ?? 0,
        createdByUserId: caller.userId,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'zone.create',
        targetType: 'zone',
        targetId: z.id,
        after: z,
      });
      return zoneView(z);
    });
  }

  async updateZone(
    caller: Caller,
    warehouseId: string,
    zoneId: string,
    input: ZoneUpdate,
  ): Promise<ZoneView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    const { expectedVersion, productCategoryIds, ...rest } = input;
    return this.runInTransaction(async (tx) => {
      const before = await this.repo.lockZone(tx, warehouseId, zoneId);
      if (before === null) throw new NotFoundError('Zone');
      if (before.version !== expectedVersion) throw versionConflict(before.version);
      this.assertTemps(
        rest.minTempC === undefined
          ? before.minTempC === null
            ? null
            : num(before.minTempC)
          : rest.minTempC,
        rest.maxTempC === undefined
          ? before.maxTempC === null
            ? null
            : num(before.maxTempC)
          : rest.maxTempC,
      );
      const after = await this.repo.updateZone(tx, zoneId, {
        ...rest,
        ...(productCategoryIds === undefined
          ? {}
          : { productCategoryIds: [...new Set(productCategoryIds)] }),
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'zone.update',
        targetType: 'zone',
        targetId: zoneId,
        before,
        after,
      });
      return zoneView(after);
    });
  }

  async deleteZone(caller: Caller, warehouseId: string, zoneId: string): Promise<void> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx) => {
      const z = await this.repo.lockZone(tx, warehouseId, zoneId);
      if (z === null) throw new NotFoundError('Zone');
      if ((await this.repo.countRacks(tx, zoneId)) > 0) throw notEmpty('racks');
      await this.repo.deleteZone(tx, zoneId);
      await this.audit(tx, caller, {
        action: 'zone.delete',
        targetType: 'zone',
        targetId: zoneId,
        before: z,
      });
    });
  }

  // ── Racks ──

  async createRack(
    caller: Caller,
    warehouseId: string,
    zoneId: string,
    input: RackInput,
  ): Promise<RackView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    const gen = input.generateBins;
    if (gen !== undefined) this.assertFits(input.code ?? 'new rack', input, [], gen.count, gen);
    return this.runInTransaction(async (tx) => {
      const zone = await this.repo.lockZone(tx, warehouseId, zoneId);
      if (zone === null) throw new NotFoundError('Zone');
      const code =
        input.code ??
        nextCodes(
          zone.code,
          await this.repo.codesWithPrefix(tx, warehouseId, `${zone.code}-`, 'rack'),
          1,
        )[0] ??
        `${zone.code}-01`;
      if ((await this.repo.codesWithPrefix(tx, warehouseId, code, 'rack')).includes(code))
        throw duplicate('Rack', code);
      const rack = await this.repo.createRack(tx, {
        warehouseId,
        zoneId,
        code,
        maxWeightKg: input.maxWeightKg,
        volumeM3: input.volumeM3,
        status: input.status ?? 'ACTIVE',
        createdByUserId: caller.userId,
        updatedByUserId: caller.userId,
      });
      if (gen !== undefined)
        await this.insertBins(
          tx,
          caller,
          rack,
          nextCodes(code, [], gen.count).map((c) => ({ code: c, ...gen })),
        );
      await this.audit(tx, caller, {
        action: 'rack.create',
        targetType: 'rack',
        targetId: rack.id,
        after: { code, zoneId, bins: gen?.count ?? 0 },
      });
      const alloc = await this.repo.allocated([rack.id], tx);
      return rackView(rack, alloc.get(rack.id));
    });
  }

  async updateRack(
    caller: Caller,
    warehouseId: string,
    rackId: string,
    input: RackUpdate,
  ): Promise<RackView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    const { expectedVersion, ...changes } = input;
    return this.runInTransaction(async (tx) => {
      const before = await this.repo.lockRack(tx, warehouseId, rackId);
      if (before === null) throw new NotFoundError('Rack');
      if (before.version !== expectedVersion) throw versionConflict(before.version);
      const alloc = (await this.repo.allocated([rackId], tx)).get(rackId);
      const weight = changes.maxWeightKg ?? num(before.maxWeightKg);
      const volume = changes.volumeM3 ?? num(before.volumeM3);
      if (weight + EPS < (alloc?.weight ?? 0) || volume + EPS < (alloc?.volume ?? 0))
        throw new ConflictError(
          'The rack limits must cover its bins (shrink or remove bins first)',
          {
            details: { reason: 'RACK_CAPACITY_EXCEEDED' },
          },
        );
      const after = await this.repo.updateRack(tx, rackId, {
        ...changes,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'rack.update',
        targetType: 'rack',
        targetId: rackId,
        before: {
          maxWeightKg: before.maxWeightKg,
          volumeM3: before.volumeM3,
          status: before.status,
        },
        after: changes,
      });
      return rackView(after, alloc);
    });
  }

  async deleteRack(caller: Caller, warehouseId: string, rackId: string): Promise<void> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx) => {
      const r = await this.repo.lockRack(tx, warehouseId, rackId);
      if (r === null) throw new NotFoundError('Rack');
      if ((await this.repo.countBins(tx, rackId)) > 0) throw notEmpty('bins');
      await this.repo.deleteRack(tx, rackId);
      await this.audit(tx, caller, {
        action: 'rack.delete',
        targetType: 'rack',
        targetId: rackId,
        before: { code: r.code },
      });
    });
  }

  // ── Bins ──

  /** One or many bins (≤ 200): explicit, or `count` auto-coded bins with the same limits. */
  async createBins(
    caller: Caller,
    warehouseId: string,
    rackId: string,
    input: BinsInput,
  ): Promise<BinView[]> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    return this.runInTransaction(async (tx) => {
      const rack = await this.repo.lockRack(tx, warehouseId, rackId);
      if (rack === null) throw new NotFoundError('Rack');
      let specs: ({ code: string } & BinLimits)[];
      if (input.bins !== undefined) {
        const used = await this.repo.codesWithPrefix(tx, warehouseId, `${rack.code}-`, 'bin');
        const auto = nextCodes(rack.code, used, input.bins.length);
        specs = input.bins.map((b, i) => ({ ...b, code: b.code ?? auto[i] ?? '' }));
      } else {
        const used = await this.repo.codesWithPrefix(tx, warehouseId, `${rack.code}-`, 'bin');
        specs = nextCodes(rack.code, used, input.count ?? 0).map((code) => ({
          code,
          maxWeightKg: input.maxWeightKg ?? 0,
          volumeM3: input.volumeM3 ?? 0,
        }));
      }
      const alloc = (await this.repo.allocated([rackId], tx)).get(rackId);
      this.assertFits(
        rack.code,
        { maxWeightKg: num(rack.maxWeightKg), volumeM3: num(rack.volumeM3) },
        [alloc],
        specs.length,
        null,
        specs,
      );
      await this.insertBins(tx, caller, rack, specs);
      await this.audit(tx, caller, {
        action: 'bin.create',
        targetType: 'rack',
        targetId: rackId,
        after: { bins: specs.map((s) => s.code) },
      });
      const page = await this.repo.bins(warehouseId, { rackId, limit: 1000 }, tx);
      const codes = new Set(specs.map((s) => s.code));
      return page.filter((b) => codes.has(b.code)).map(binView);
    });
  }

  async updateBin(
    caller: Caller,
    warehouseId: string,
    binId: string,
    input: BinUpdate,
  ): Promise<BinView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    return this.runInTransaction(async (tx) => {
      const before = await this.repo.bin(warehouseId, binId, tx);
      if (before === null) throw new NotFoundError('Bin');
      const rack = await this.repo.lockRack(tx, warehouseId, before.rackId);
      if (rack === null) throw new NotFoundError('Rack');
      if (input.maxWeightKg !== undefined || input.volumeM3 !== undefined) {
        const alloc = (await this.repo.allocated([rack.id], tx)).get(rack.id);
        const weight =
          (alloc?.weight ?? 0) -
          num(before.maxWeightKg) +
          (input.maxWeightKg ?? num(before.maxWeightKg));
        const volume =
          (alloc?.volume ?? 0) - num(before.volumeM3) + (input.volumeM3 ?? num(before.volumeM3));
        if (weight > num(rack.maxWeightKg) + EPS || volume > num(rack.volumeM3) + EPS)
          throw overCapacity(
            rack.code,
            num(rack.maxWeightKg) - (alloc?.weight ?? 0) + num(before.maxWeightKg),
            num(rack.volumeM3) - (alloc?.volume ?? 0) + num(before.volumeM3),
          );
        if (
          (input.maxWeightKg ?? Infinity) < num(before.usedWeightKg) ||
          (input.volumeM3 ?? Infinity) < num(before.usedVolumeM3)
        )
          throw new ConflictError('The bin already holds more than that', {
            details: { reason: 'BIN_IN_USE' },
          });
      }
      const after = await this.repo.updateBin(tx, binId, input);
      await this.audit(tx, caller, {
        action: 'bin.update',
        targetType: 'bin',
        targetId: binId,
        before,
        after: input,
      });
      return binView(after);
    });
  }

  async deleteBin(caller: Caller, warehouseId: string, binId: string): Promise<void> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx) => {
      const b = await this.repo.bin(warehouseId, binId, tx);
      if (b === null) throw new NotFoundError('Bin');
      if (num(b.usedWeightKg) > 0 || num(b.usedVolumeM3) > 0)
        throw new ConflictError('The bin holds stock', { details: { reason: 'BIN_IN_USE' } });
      await this.repo.deleteBin(tx, binId);
      await this.audit(tx, caller, {
        action: 'bin.delete',
        targetType: 'bin',
        targetId: binId,
        before: { code: b.code },
      });
    });
  }

  // ── Helpers ──

  private async insertBins(
    tx: Tx,
    caller: Caller,
    rack: RackRow,
    specs: readonly ({ code: string } & BinLimits)[],
  ): Promise<void> {
    const codes = specs.map((s) => s.code);
    if (new Set(codes).size !== codes.length)
      throw new ValidationError([{ path: 'body.bins', message: 'bin codes repeat' }]);
    const taken = await this.repo.existingBinCodes(tx, rack.warehouseId, codes);
    if (taken.length > 0) throw duplicate('Bin', taken[0] ?? '');
    await this.repo.createBins(
      tx,
      specs.map((s) => ({
        warehouseId: rack.warehouseId,
        zoneId: rack.zoneId,
        rackId: rack.id,
        code: s.code,
        maxWeightKg: s.maxWeightKg,
        volumeM3: s.volumeM3,
        createdByUserId: caller.userId,
      })),
    );
  }

  /** Σ(new bins) + already allocated ≤ rack limits; 409 RACK_CAPACITY_EXCEEDED otherwise. */
  private assertFits(
    rackCode: string,
    rack: BinLimits,
    existing: readonly ({ weight: number; volume: number } | undefined)[],
    count: number,
    each: BinLimits | null,
    specs?: readonly BinLimits[],
  ): void {
    if (count > MAX_BINS_PER_CALL)
      throw new ValidationError([
        { path: 'body', message: `at most ${MAX_BINS_PER_CALL} bins per request` },
      ]);
    const list =
      specs ?? Array.from({ length: count }, () => each ?? { maxWeightKg: 0, volumeM3: 0 });
    const usedW = existing.reduce((n, a) => n + (a?.weight ?? 0), 0);
    const usedV = existing.reduce((n, a) => n + (a?.volume ?? 0), 0);
    const addW = list.reduce((n, b) => n + b.maxWeightKg, 0);
    const addV = list.reduce((n, b) => n + b.volumeM3, 0);
    if (usedW + addW > rack.maxWeightKg + EPS || usedV + addV > rack.volumeM3 + EPS)
      throw overCapacity(rackCode, rack.maxWeightKg - usedW, rack.volumeM3 - usedV);
  }

  private assertTemps(min: number | null | undefined, max: number | null | undefined): void {
    if (min != null && max != null && min > max)
      throw new ValidationError([{ path: 'body.minTempC', message: 'must not exceed maxTempC' }]);
  }

  private visible(caller: Caller, warehouseId: string, key: string) {
    return this.lazy.warehousesService.requireVisible(caller, warehouseId, key);
  }

  private audit(tx: Tx, caller: Caller, entry: AuditEntry): Promise<void> {
    return this.auditService.record(tx, actorOf(caller), entry);
  }
}
