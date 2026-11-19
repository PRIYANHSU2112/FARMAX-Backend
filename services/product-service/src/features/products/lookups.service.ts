import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { productKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import type {
  CreateLookupInput,
  LookupGroup,
  LookupListQuery,
  LookupRecord,
  LookupRow,
  PublicLookup,
  UpdateLookupInput,
} from './lookups.types.js';

type Deps = Pick<Cradle, 'lookupsRepository' | 'cache' | 'runInTransaction' | 'auditService'>;

const CACHE_TTL_SECONDS = 600;
const cacheKey = () => productKeys.keyspace.key('lookups');

export interface LookupRefs {
  /** [jsonPath, lookupId, expected group] */
  refs: [path: string, id: string, group: LookupGroup][];
}

/**
 * Dynamic master data (dosage forms, routes, species, units). Admins add values; nothing is a
 * hard-coded enum. A value in use can only be deactivated (existing products keep it).
 */
export class LookupsService {
  constructor(private readonly deps: Deps) {}

  async publicList(group: LookupGroup | undefined): Promise<PublicLookup[]> {
    const rows = await this.deps.cache.getOrSet(cacheKey(), CACHE_TTL_SECONDS, () =>
      this.deps.lookupsRepository.activeAll(),
    );
    return rows
      .filter((row) => group === undefined || row.group === group)
      .map(({ id, group: g, code, label, meta }) => ({ id, group: g, code, label, meta }));
  }

  list(query: LookupListQuery): Promise<LookupRecord[]> {
    return this.deps.lookupsRepository.list(query);
  }

  async detail(id: string): Promise<LookupRecord> {
    const row = await this.deps.lookupsRepository.findLive(id);
    if (row === null) throw new NotFoundError('Lookup');
    return row;
  }

  /**
   * Validates every referenced lookup (exists, right group, active) inside the product write
   * transaction. Returns the rows by id (species meta drives withdrawal rules).
   */
  async resolve(tx: Tx, { refs }: LookupRefs): Promise<Map<string, LookupRow>> {
    const ids = [...new Set(refs.map(([, id]) => id))];
    const rows = await this.deps.lookupsRepository.findByIds(tx, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const issues = refs.flatMap(([path, id, group]) => {
      const row = byId.get(id);
      if (row === undefined) return [{ path, message: 'Unknown value' }];
      if (row.group !== group) return [{ path, message: `Must be a ${group} value` }];
      if (!row.isActive) return [{ path, message: `"${row.label}" is inactive` }];
      return [];
    });
    if (issues.length > 0) throw new ValidationError(issues);
    return byId;
  }

  async create(input: CreateLookupInput, actor: Actor): Promise<LookupRecord> {
    const { reason, ...fields } = input;
    const row = await this.deps.runInTransaction(async (tx) => {
      if (await this.deps.lookupsRepository.codeTaken(tx, fields.group, fields.code)) {
        throw new ConflictError(`${fields.group} code ${fields.code} already exists`, {
          details: { reason: 'LOOKUP_DUPLICATE', fields: ['code'] },
        });
      }
      const created = await this.deps.lookupsRepository.create(tx, fields, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'lookup.create',
        targetType: 'lookup',
        targetId: created.id,
        after: created,
        reason,
      });
      return created;
    });
    await this.invalidate();
    return row;
  }

  async update(
    id: string,
    input: UpdateLookupInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<LookupRecord> {
    const { reason, ...changes } = input;
    const row = await this.deps.runInTransaction(async (tx) => {
      const current = await this.liveOrThrow(tx, id, ifMatch);
      const updated = await this.deps.lookupsRepository.update(tx, id, changes, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'lookup.update',
        targetType: 'lookup',
        targetId: id,
        before: current,
        after: changes,
        reason,
      });
      return updated;
    });
    await this.invalidate();
    return row;
  }

  async remove(
    id: string,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      const current = await this.liveOrThrow(tx, id, ifMatch);
      const used = await this.deps.lookupsRepository.usageCount(tx, id);
      if (used > 0) {
        throw new ConflictError('This value is in use; deactivate it instead', {
          details: { reason: 'LOOKUP_IN_USE', count: used },
        });
      }
      await this.deps.lookupsRepository.softDelete(tx, id, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'lookup.delete',
        targetType: 'lookup',
        targetId: id,
        before: current,
        reason,
      });
    });
    await this.invalidate();
  }

  private async liveOrThrow(tx: Tx, id: string, ifMatch: number | undefined) {
    const row = await this.deps.lookupsRepository.findLive(id, tx);
    if (row === null) throw new NotFoundError('Lookup');
    if (ifMatch !== undefined && ifMatch !== row.version) {
      throw new ConflictError('The value was changed by someone else; reload and retry', {
        details: { reason: 'VERSION_CONFLICT', currentVersion: row.version },
      });
    }
    return row;
  }

  private async invalidate(): Promise<void> {
    await this.deps.cache.invalidate(cacheKey()).catch(() => undefined);
  }
}
