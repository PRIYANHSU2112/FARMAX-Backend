import { ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { NotificationConfig } from '../config/index.js';

export type DirectoryUserType = 'INTERNAL' | 'CUSTOMER' | 'VENDOR' | 'LOGISTICS_PARTNER';

/** auth-service `/internal/users/:id/contact` (no credentials, ever). */
export interface UserContact {
  id: string;
  userType: DirectoryUserType;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'LOCKED' | 'SUSPENDED' | 'DEACTIVATED';
  fullName: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  preferredLanguage: string;
}

const TIMEOUT_MS = 1_500;

/**
 * auth-service's internal directory: delivery addresses and audiences. Used only off the request
 * path (event consumer, fan-out, workers). Any failure throws ServiceUnavailableError, which the
 * callers treat as RETRYABLE (the event is requeued / the delivery retried), never as "no one".
 */
export class AuthDirectory {
  constructor(private readonly deps: { config: NotificationConfig; logger: Logger }) {}

  /** Null when the user does not exist (or is deleted). */
  async getContact(userId: string): Promise<UserContact | null> {
    const body = await this.get<UserContact>(
      `/internal/users/${encodeURIComponent(userId)}/contact`,
      true,
    );
    return body ?? null;
  }

  /** ACTIVE staff holding `permission` at GLOBAL scope or at `warehouseId`. */
  async listPermissionHolders(permission: string, warehouseId?: string | null): Promise<string[]> {
    const query = new URLSearchParams({ permission });
    if (warehouseId != null) query.set('warehouseId', warehouseId);
    const body = await this.get<{ userIds: string[] }>(
      `/internal/access/recipients?${query.toString()}`,
    );
    return body?.userIds ?? [];
  }

  /** One keyset page of ACTIVE user ids of a type (APP audiences). */
  async listActiveIds(
    userType: DirectoryUserType,
    cursor: string | null,
    limit: number,
  ): Promise<{ ids: string[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ userType, limit: String(limit) });
    if (cursor !== null) query.set('cursor', cursor);
    const body = await this.get<{ ids: string[]; nextCursor: string | null }>(
      `/internal/users/ids?${query.toString()}`,
    );
    return body ?? { ids: [], nextCursor: null };
  }

  private async get<T>(path: string, notFoundIsNull = false): Promise<T | undefined> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined)
      throw new ServiceUnavailableError('INTERNAL_SERVICE_TOKEN is not configured');
    let res: Response;
    try {
      res = await fetch(`${config.AUTH_SERVICE_URL}${path}`, {
        headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn({ err: error, path: path.split('?')[0] }, 'auth directory unreachable');
      throw new ServiceUnavailableError('auth-service unavailable', { cause: error });
    }
    if (res.status === 404 && notFoundIsNull) return undefined;
    if (!res.ok) throw new ServiceUnavailableError(`auth-service answered ${res.status}`);
    return ((await res.json()) as { data?: T }).data;
  }
}
