import { BadRequestError, NotFoundError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { WarehouseCoverageReplacedV1, WarehouseUpsertedV1 } from '@farmx/infra/events';
import { inventoryKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { AllocationCandidate, WarehouseView } from './warehouses.types.js';

const COVERAGE_TTL_SECONDS = 60;
const COLD = new Set(['CC_REF', 'CC_FRZ']);

/**
 * The warehouses inventory allocates to: a read-only copy of warehouse-service master data
 * (D-56), applied from `warehouse.*` events (version-guarded, same ids). Allocation reads PIN
 * coverage through a short Redis cache invalidated by a version key on every applied change.
 */
export class WarehousesService {
  private readonly repo: Cradle['warehousesRepository'];
  private readonly redis: Cradle['redis'];
  private readonly logger: Cradle['logger'];
  /** Lazy (awilix proxy): stock depends on warehouses, so it is resolved at call time. */
  private readonly lazy: Pick<Cradle, 'stockService'>;

  constructor(deps: Pick<Cradle, 'warehousesRepository' | 'redis' | 'logger' | 'stockService'>) {
    this.lazy = deps;
    this.repo = deps.warehousesRepository;
    this.redis = deps.redis;
    this.logger = deps.logger;
  }

  // ── Projection (event consumer, inside the inbox transaction) ──

  /**
   * ACTIVE and LIMITED take stock movements; only ACTIVE plus the admin switch is allocatable;
   * a cold-chain warehouse stores CC_REF or CC_FRZ. A discarded draft is removed.
   */
  async applyUpserted(tx: Tx, d: WarehouseUpsertedV1): Promise<void> {
    if (d.deleted) {
      if (await this.repo.deleteIfNotNewer(tx, d.warehouseId, d.version))
        await this.afterChange(tx, d.warehouseId, true);
      return;
    }
    const { changed, allocationChanged } = await this.repo.upsertNewer(tx, {
      id: d.warehouseId,
      version: d.version,
      code: d.code,
      name: d.name,
      type: d.type,
      addressLine: d.addressLine,
      city: d.city,
      stateCode: d.stateCode,
      pinCode: d.pinCode,
      isActive: d.status === 'ACTIVE' || d.status === 'LIMITED',
      isAllocatable: d.status === 'ACTIVE' && d.isAllocatable,
      hasColdChain: d.temperatureClasses.some((c) => COLD.has(c)),
      priority: d.priority,
    });
    if (changed) await this.afterChange(tx, d.warehouseId, allocationChanged);
  }

  async applyCoverage(tx: Tx, d: WarehouseCoverageReplacedV1): Promise<void> {
    if (await this.repo.replaceCoverageIfNewer(tx, d.warehouseId, d.coverageVersion, d.entries))
      await this.afterChange(tx, d.warehouseId, false);
  }

  // ── Reads (allocation, stock movements) ──

  /**
   * Allocation candidates for a PIN (best first). Cached 60 s under the coverage version, so any
   * applied warehouse / coverage change is visible at once; Redis down → straight from the DB.
   */
  async candidatesForPin(pinCode: string): Promise<AllocationCandidate[]> {
    let key: string | undefined;
    try {
      const version = (await this.redis.get(inventoryKeys.coverageVersion())) ?? '0';
      key = inventoryKeys.coverage(version, pinCode);
      const cached = await this.redis.get(key);
      if (cached !== null) return JSON.parse(cached) as AllocationCandidate[];
    } catch (err) {
      this.logger.warn({ err }, 'coverage cache unavailable; reading the database');
      key = undefined;
    }
    const rows = await this.repo.candidates(pinCode);
    if (key !== undefined)
      await this.redis
        .set(key, JSON.stringify(rows), 'EX', COVERAGE_TTL_SECONDS)
        .catch(() => undefined);
    return rows;
  }

  allocatableIds(): Promise<string[]> {
    return this.repo.allocatableIds();
  }

  async requireExists(tx: Tx, id: string): Promise<WarehouseView> {
    const row = await this.repo.find(id, tx);
    if (row === null) throw new NotFoundError('Warehouse');
    return row;
  }

  /** For stock movements: the warehouse must exist and be active (checked inside the tx). */
  async requireActive(tx: Tx, id: string): Promise<WarehouseView> {
    const row = await this.requireExists(tx, id);
    if (!row.isActive) throw new BadRequestError('Warehouse is inactive');
    return row;
  }

  /**
   * Cached candidates are dropped (version key; at worst they live COVERAGE_TTL_SECONDS longer if
   * Redis fails) and, when allocatability changed, every stocked variant's network availability
   * is recomputed (the dirty marks commit with the change).
   */
  private async afterChange(tx: Tx, id: string, allocationChanged: boolean): Promise<void> {
    if (allocationChanged) await this.lazy.stockService.markWarehouseDirty(id, tx);
    await this.redis.incr(inventoryKeys.coverageVersion()).catch((err: unknown) => {
      this.logger.warn({ err }, 'coverage cache version bump failed');
    });
  }
}
