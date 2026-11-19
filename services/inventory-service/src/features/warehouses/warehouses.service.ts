import { BadRequestError, ConflictError, NotFoundError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { inventoryKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import type {
  AllocationCandidate,
  CoverageView,
  CreateWarehouseInput,
  PutCoverageInput,
  UpdateWarehouseInput,
  WarehouseListQuery,
  WarehouseStatusInput,
  WarehouseView,
} from './warehouses.types.js';

const COVERAGE_TTL_SECONDS = 60;

const staffId = (actor: Actor): string => {
  if (actor.userId === null) throw new Error('warehouse changes need a staff actor');
  return actor.userId;
};

const versionConflict = (current: number) =>
  new ConflictError('The warehouse was changed by someone else; reload and retry', {
    details: { reason: 'VERSION_CONFLICT', currentVersion: current },
  });

/**
 * Warehouses are master data: every change is audited and bumps `version` (optimistic
 * concurrency through `expectedVersion`, under a row lock). Coverage + flags feed allocation,
 * which reads them through a short Redis cache invalidated by a version key on every change.
 */
export class WarehousesService {
  private readonly repo: Cradle['warehousesRepository'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly auditService: Cradle['auditService'];
  private readonly redis: Cradle['redis'];
  private readonly logger: Cradle['logger'];
  /** Lazy (awilix proxy): stock depends on warehouses, so it is resolved at call time, not here. */
  private readonly lazy: Pick<Cradle, 'stockService'>;

  constructor(
    deps: Pick<
      Cradle,
      'warehousesRepository' | 'runInTransaction' | 'auditService' | 'redis' | 'logger' | 'stockService'
    >,
  ) {
    this.lazy = deps;
    this.repo = deps.warehousesRepository;
    this.runInTransaction = deps.runInTransaction;
    this.auditService = deps.auditService;
    this.redis = deps.redis;
    this.logger = deps.logger;
  }

  list(query: WarehouseListQuery): Promise<Paginated<WarehouseView>> {
    return this.repo.list(query);
  }

  async get(id: string): Promise<WarehouseView> {
    const row = await this.repo.find(id);
    if (row === null) throw new NotFoundError('Warehouse');
    return row;
  }

  async create(actor: Actor, input: CreateWarehouseInput): Promise<WarehouseView> {
    const view = await this.runInTransaction(async (tx) => {
      const created = await this.repo.create(tx, input, staffId(actor));
      await this.auditService.record(tx, actor, {
        action: 'warehouse.create',
        targetType: 'warehouse',
        targetId: created.id,
        after: created,
      });
      return created;
    });
    await this.bumpCoverageVersion();
    return view;
  }

  async update(actor: Actor, id: string, input: UpdateWarehouseInput): Promise<WarehouseView> {
    const { expectedVersion, reason, ...changes } = input;
    const view = await this.runInTransaction(async (tx) => {
      const before = await this.lockedAt(tx, id, expectedVersion);
      const after = await this.repo.update(tx, id, changes, staffId(actor));
      await this.auditService.record(tx, actor, {
        action: 'warehouse.update',
        targetType: 'warehouse',
        targetId: id,
        before: pick(before, Object.keys(changes)),
        after: pick(after, Object.keys(changes)),
        reason: reason ?? null,
      });
      return after;
    });
    await this.bumpCoverageVersion();
    if (changes.isAllocatable !== undefined) await this.recomputeAvailability(id);
    return view;
  }

  /** Activate / deactivate. An inactive warehouse takes no new movements and is never allocated. */
  async setStatus(actor: Actor, id: string, input: WarehouseStatusInput): Promise<WarehouseView> {
    const view = await this.runInTransaction(async (tx) => {
      const before = await this.lockedAt(tx, id, input.expectedVersion);
      if (before.isActive === input.isActive)
        throw new ConflictError(`Warehouse is already ${input.isActive ? 'active' : 'inactive'}`);
      const after = await this.repo.update(
        tx,
        id,
        { isActive: input.isActive, statusReason: input.reason },
        staffId(actor),
      );
      await this.auditService.record(tx, actor, {
        action: input.isActive ? 'warehouse.activate' : 'warehouse.deactivate',
        targetType: 'warehouse',
        targetId: id,
        before: { isActive: before.isActive },
        after: { isActive: after.isActive },
        reason: input.reason,
      });
      return after;
    });
    await this.bumpCoverageVersion();
    await this.recomputeAvailability(id);
    return view;
  }

  async coverage(id: string): Promise<CoverageView> {
    const warehouse = await this.get(id);
    return { warehouseId: id, version: warehouse.version, entries: await this.repo.coverage(id) };
  }

  /** Replaces the whole PIN list (bumps the warehouse version). */
  async putCoverage(actor: Actor, id: string, input: PutCoverageInput): Promise<CoverageView> {
    await this.runInTransaction(async (tx) => {
      await this.lockedAt(tx, id, input.expectedVersion);
      const removed = await this.repo.replaceCoverage(tx, id, input.entries);
      await this.repo.update(tx, id, {}, staffId(actor));
      await this.auditService.record(tx, actor, {
        action: 'warehouse.coverage_replace',
        targetType: 'warehouse',
        targetId: id,
        before: { count: removed },
        after: { count: input.entries.length },
        reason: input.reason,
      });
    });
    await this.bumpCoverageVersion();
    return this.coverage(id);
  }

  /**
   * Allocation candidates for a PIN (best first). Cached 60 s under the coverage version, so any
   * warehouse / coverage change is visible at once; Redis down → straight from the database.
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
    const row = await this.repo.find(id, tx);
    if (row === null) throw new NotFoundError('Warehouse');
    if (!row.isActive) throw new BadRequestError('Warehouse is inactive');
    return row;
  }

  private async lockedAt(tx: Tx, id: string, expectedVersion: number): Promise<WarehouseView> {
    const row = await this.repo.lock(tx, id);
    if (row === null) throw new NotFoundError('Warehouse');
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  /** Network availability counts only active + allocatable warehouses: recompute its variants. */
  private async recomputeAvailability(id: string): Promise<void> {
    await this.lazy.stockService.markWarehouseDirty(id).catch((err: unknown) => {
      this.logger.error({ err, warehouseId: id }, 'availability dirty mark failed');
    });
  }

  private async bumpCoverageVersion(): Promise<void> {
    await this.redis.incr(inventoryKeys.coverageVersion()).catch((err: unknown) => {
      // Cached candidates then live at most COVERAGE_TTL_SECONDS longer.
      this.logger.warn({ err }, 'coverage cache version bump failed');
    });
  }
}

const pick = (row: WarehouseView, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.map((k) => [k, (row as unknown as Record<string, unknown>)[k]]));
