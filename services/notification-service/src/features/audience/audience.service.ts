import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { NotificationApp, NotificationAudience } from '../../domain.js';
import {
  APP_USER_TYPE,
  type AudienceColumns,
  type AudiencePage,
  type AudienceSpec,
  type OrderRef,
} from './audience.types.js';

/** Recipients created per transaction (inline in the consumer, or per fan-out page). */
export const PAGE_SIZE = 500;

type Deps = Pick<Cradle, 'audienceRepository' | 'authDirectory'>;

/**
 * Turns an audience into user ids. Explicit user lists resolve inline (no I/O). Staff and
 * app-wide audiences need auth-service, so they are resolved by the fan-out job (off the
 * consumer / request path, retried with backoff).
 */
export class AudienceService {
  constructor(private readonly deps: Deps) {}

  recordOrder(tx: Tx, ref: OrderRef): Promise<void> {
    return this.deps.audienceRepository.insertOrder(tx, ref);
  }

  findOrder(orderId: string, tx?: Tx): Promise<OrderRef | null> {
    return this.deps.audienceRepository.findOrder(orderId, tx);
  }

  /** User ids when known without I/O and small enough for one transaction; else null. */
  resolveInline(spec: AudienceSpec): string[] | null {
    if (spec.kind !== 'users') return null;
    const ids = [...new Set(spec.userIds)];
    return ids.length <= PAGE_SIZE ? ids : null;
  }

  /** One page of recipients for the fan-out job. Throws (retryable) when auth-service fails. */
  async resolvePage(
    spec: AudienceSpec,
    app: NotificationApp,
    cursor: string | null,
  ): Promise<AudiencePage> {
    switch (spec.kind) {
      case 'users': {
        const ids = [...new Set(spec.userIds)];
        const from = cursor === null ? 0 : Number(cursor);
        const to = from + PAGE_SIZE;
        return { userIds: ids.slice(from, to), nextCursor: to < ids.length ? String(to) : null };
      }
      case 'permission': {
        const ids = await this.deps.authDirectory.listPermissionHolders(
          spec.permission,
          spec.warehouseId ?? null,
        );
        return { userIds: ids, nextCursor: null };
      }
      case 'app': {
        const page = await this.deps.authDirectory.listActiveIds(
          APP_USER_TYPE[app],
          cursor,
          PAGE_SIZE,
        );
        return { userIds: page.ids, nextCursor: page.nextCursor };
      }
    }
  }
}

export const toColumns = (spec: AudienceSpec): AudienceColumns => {
  switch (spec.kind) {
    case 'users':
      return {
        audienceType: spec.userIds.length === 1 ? 'USER' : 'USERS',
        audience: { userIds: spec.userIds },
      };
    case 'permission':
      return {
        audienceType: 'PERMISSION',
        audience: { permission: spec.permission, warehouseId: spec.warehouseId ?? null },
      };
    case 'app':
      return { audienceType: 'APP', audience: {} };
  }
};

export const fromColumns = (type: NotificationAudience, audience: unknown): AudienceSpec => {
  const a = (audience ?? {}) as { userIds?: string[]; permission?: string; warehouseId?: string };
  switch (type) {
    case 'USER':
    case 'USERS':
      return { kind: 'users', userIds: a.userIds ?? [] };
    case 'PERMISSION':
      return { kind: 'permission', permission: a.permission ?? '', warehouseId: a.warehouseId };
    case 'APP':
      return { kind: 'app' };
  }
};
