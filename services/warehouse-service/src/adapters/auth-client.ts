import {
  type AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';
import { type Redis, warehouseKeys } from '@farmx/infra/redis';

import type { WarehouseConfig } from '../config/index.js';

/** What warehouse screens show about a staff user (manager column, team list). */
export interface StaffContact {
  id: string;
  userType: string;
  status: string;
  fullName: string;
  email: string | null;
  phone: string | null;
}

/** A role that can be granted at a warehouse (auth-service template). */
export interface WarehouseRoleTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  usage: { staffCount: number; warehouseCount: number };
}

export interface ScopeMember {
  userId: string;
  roles: { roleId: string; roleKey: string; roleName: string; assignedAt: string }[];
}

export interface InviteResult {
  userId: string;
  created: boolean;
  granted: boolean;
  invitationSent: boolean;
  status: string;
}

interface ErrorBody {
  error?: {
    message?: string;
    details?: { issues?: { path: string; message: string }[] } & Record<string, unknown>;
  };
}

/** auth-service's error, re-raised with the same status, message and details. */
const relay = (status: number, body: ErrorBody, retryAfter: string | null): AppError => {
  const message = body.error?.message ?? 'Request refused by auth-service';
  const options = { details: body.error?.details };
  switch (status) {
    case 400:
      return new BadRequestError(message, options);
    case 403:
      return new ForbiddenError(message, options);
    case 404:
      return new NotFoundError('Team member', options);
    case 409:
      return new ConflictError(message, options);
    case 422:
      return new ValidationError(
        body.error?.details?.issues ?? [{ path: 'body', message }],
        message,
      );
    case 429:
      return new RateLimitError(Number(retryAfter ?? '30'));
    default:
      return new ServiceUnavailableError('Staff directory unavailable; retry');
  }
};

const CONTACT_TTL_SECONDS = 300;
const BATCH = 100;

/**
 * auth-service over `/internal/*` (D-56). Contacts are cached per user for 5 minutes (one MGET,
 * then ONE batch call for the misses), so a list page never makes one call per row. Failures
 * degrade to "unknown" (missing entries), never to an error page.
 */
export class AuthClient {
  constructor(
    private readonly deps: { config: WarehouseConfig; logger: Logger; redis: () => Redis },
  ) {}

  async contacts(ids: readonly string[]): Promise<Map<string, StaffContact>> {
    const unique = [...new Set(ids)];
    const found = new Map<string, StaffContact>();
    if (unique.length === 0) return found;
    const { redis, logger } = this.deps;
    let missing = unique;
    try {
      const cached = await redis().mget(...unique.map((id) => warehouseKeys.contact(id)));
      missing = [];
      unique.forEach((id, i) => {
        const raw = cached[i];
        if (typeof raw === 'string') found.set(id, JSON.parse(raw) as StaffContact);
        else missing.push(id);
      });
    } catch (err) {
      logger.warn({ err }, 'contact cache unavailable; asking auth-service');
    }
    for (let i = 0; i < missing.length; i += BATCH) {
      const fetched = (await this.fetchContacts(missing.slice(i, i + BATCH))) ?? [];
      for (const contact of fetched) found.set(contact.id, contact);
      if (fetched.length === 0) continue;
      try {
        const pipeline = redis().multi();
        for (const contact of fetched)
          pipeline.set(
            warehouseKeys.contact(contact.id),
            JSON.stringify(contact),
            'EX',
            CONTACT_TTL_SECONDS,
          );
        await pipeline.exec();
      } catch {
        // Cache write is best-effort.
      }
    }
    return found;
  }

  /**
   * A manager / in-charge must be a live staff account (ACTIVE, or invited and not accepted yet).
   * 422 on `field` otherwise; 503 when auth-service cannot answer (never a silent pass).
   */
  async requireStaffUser(userId: string, field: string): Promise<StaffContact> {
    const fetched = await this.fetchContacts([userId]);
    if (fetched === null) throw new ServiceUnavailableError('Staff directory unavailable; retry');
    const contact = fetched[0];
    if (
      contact?.userType !== 'INTERNAL' ||
      !['ACTIVE', 'PENDING_VERIFICATION'].includes(contact.status)
    )
      throw new ValidationError([{ path: field, message: 'must be an active staff user' }]);
    return contact;
  }

  // ── Team (D-56): invitations and warehouse role assignments, re-checked by auth-service ──

  warehouseRoles(): Promise<WarehouseRoleTemplate[]> {
    return this.call<{ roles: WarehouseRoleTemplate[] }>(
      'GET',
      '/internal/access/warehouse-roles',
    ).then((d) => d.roles);
  }

  scopeMembers(warehouseId: string): Promise<ScopeMember[]> {
    return this.call<{ members: ScopeMember[] }>(
      'GET',
      `/internal/access/scope-members?scopeType=WAREHOUSE&scopeId=${warehouseId}`,
    ).then((d) => d.members);
  }

  invite(body: {
    email: string;
    fullName: string;
    roleId: string;
    warehouseId: string;
    invitedByUserId: string;
    requestId: string;
    reason?: string;
  }): Promise<InviteResult> {
    return this.call('POST', '/internal/staff/invitations', body);
  }

  resend(body: {
    userId: string;
    warehouseId: string;
    requestedByUserId: string;
    requestId: string;
  }) {
    return this.call<{ invitationSent: boolean }>(
      'POST',
      '/internal/staff/invitations/resend',
      body,
    );
  }

  revoke(body: {
    userId: string;
    warehouseId: string;
    roleId?: string;
    revokedByUserId: string;
    reason: string;
    requestId: string;
  }) {
    return this.call<{ revoked: number }>('POST', '/internal/staff/assignments/revoke', body);
  }

  /** D-57b step-up: the person's current TOTP code (single use; 5 wrong codes → locked 15 min). */
  verifyStepUp(userId: string, code: string) {
    return this.call<{ valid: boolean; locked: boolean }>('POST', '/internal/staff/mfa/verify', {
      userId,
      code,
    });
  }

  /** One internal call; non-2xx → the same AppError; no answer → 503. Contacts cache dropped. */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined)
      throw new ServiceUnavailableError('Staff directory is not configured');
    let res: Response;
    try {
      res = await fetch(`${config.AUTH_SERVICE_URL}${path}`, {
        method,
        headers: {
          [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      logger.warn({ err, path }, 'auth-service call failed');
      throw new ServiceUnavailableError('Staff directory unavailable; retry', { cause: err });
    }
    const json = (await res.json().catch(() => ({}))) as { data?: T } & ErrorBody;
    if (!res.ok) throw relay(res.status, json, res.headers.get('retry-after'));
    return json.data as T;
  }

  /** Forget cached contacts (a name may have changed with an invitation). */
  async forget(userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.deps
      .redis()
      .del(...userIds.map((id) => warehouseKeys.contact(id)))
      .catch(() => undefined);
  }

  /** null = auth-service did not answer (unconfigured, down, error status). */
  private async fetchContacts(ids: readonly string[]): Promise<StaffContact[] | null> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return null;
    try {
      const res = await fetch(`${config.AUTH_SERVICE_URL}/internal/users/contacts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN,
        },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'auth-service contacts lookup failed');
        return null;
      }
      const body = (await res.json()) as { data?: { contacts?: StaffContact[] } };
      return (body.data?.contacts ?? []).map((c) => ({
        id: c.id,
        userType: c.userType,
        status: c.status,
        fullName: c.fullName,
        email: c.email,
        phone: c.phone,
      }));
    } catch (err) {
      logger.warn({ err }, 'auth-service contacts lookup failed');
      return null;
    }
  }
}
