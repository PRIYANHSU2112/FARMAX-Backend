import { NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { farmKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { LocalCache } from '../../adapters/local-cache.js';
import type { Actor } from '../audit/index.js';
import type {
  PinInput,
  PinListQuery,
  PinView,
  TerritoryInput,
  TerritoryView,
} from './geo.types.js';

const PIN_TTL_SECONDS = 86_400;

type Deps = Pick<Cradle, 'geoRepository' | 'cache' | 'runInTransaction' | 'auditService'>;

/**
 * Pin code → territory / mandal / serving nodes. Read path: in-process LRU (≈0 ms) → Redis
 * (single-flight, 24 h) → Postgres primary key. Unknown pins are negatively cached as `null`.
 */
export class GeoService {
  private readonly local = new LocalCache<PinView | null>(5_000, 5 * 60_000);

  constructor(private readonly deps: Deps) {}

  async lookupPin(pinCode: string): Promise<PinView> {
    const pin = await this.findPin(pinCode);
    if (pin === null) throw new NotFoundError('Pin code');
    return pin;
  }

  /** For farm locations: the pin must exist and be serviceable (422 otherwise). */
  async resolveServiceablePin(pinCode: string): Promise<PinView> {
    const pin = await this.findPin(pinCode);
    if (pin?.serviceable !== true) {
      throw new ValidationError([
        { path: 'pinCode', message: 'FarmX does not deliver to this pin code yet' },
      ]);
    }
    return pin;
  }

  private async findPin(pinCode: string): Promise<PinView | null> {
    const hit = this.local.get(pinCode);
    if (hit !== undefined) return hit;
    const pin = await this.deps.cache.getOrSet(farmKeys.pin(pinCode), PIN_TTL_SECONDS, () =>
      this.deps.geoRepository.findPin(pinCode),
    );
    this.local.set(pinCode, pin);
    return pin;
  }

  // ── Admin ──

  listPins(query: PinListQuery): Promise<Paginated<PinView>> {
    return this.deps.geoRepository.listPins(query);
  }

  async upsertPin(pinCode: string, input: PinInput, actor: Actor): Promise<PinView> {
    const territory = await this.deps.geoRepository.findTerritoryByCode(input.territoryCode);
    if (territory === null)
      throw new ValidationError([{ path: 'territoryCode', message: 'Unknown territory' }]);
    const { reason, ...data } = input;
    const view = await this.deps.runInTransaction(async (tx) => {
      const saved = await this.deps.geoRepository.upsertPin(tx, pinCode, territory.id, data);
      await this.deps.auditService.record(tx, actor, {
        action: 'geo.pincode.upsert',
        targetType: 'pincode',
        targetId: pinCode,
        after: saved,
        reason,
      });
      return saved;
    });
    this.local.delete(pinCode);
    await this.deps.cache.invalidate(farmKeys.pin(pinCode)).catch(() => undefined);
    return view;
  }

  listTerritories(): Promise<TerritoryView[]> {
    return this.deps.geoRepository.listTerritories();
  }

  createTerritory(
    input: TerritoryInput & { reason: string },
    actor: Actor,
  ): Promise<TerritoryView> {
    const { reason, ...data } = input;
    return this.deps.runInTransaction(async (tx) => {
      const created = await this.deps.geoRepository.createTerritory(tx, data);
      await this.deps.auditService.record(tx, actor, {
        action: 'geo.territory.create',
        targetType: 'territory',
        targetId: created.id,
        after: created,
        reason,
      });
      return created;
    });
  }

  updateTerritory(
    id: string,
    input: Partial<TerritoryInput> & { reason: string },
    actor: Actor,
  ): Promise<TerritoryView> {
    const { reason, ...data } = input;
    return this.deps.runInTransaction(async (tx) => {
      const updated = await this.deps.geoRepository.updateTerritory(tx, id, data);
      await this.deps.auditService.record(tx, actor, {
        action: 'geo.territory.update',
        targetType: 'territory',
        targetId: id,
        after: updated,
        reason,
      });
      return updated;
    });
  }
}
