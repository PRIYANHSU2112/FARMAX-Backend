import { BadRequestError, ConflictError, NotFoundError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { type Tx, isUniqueViolation } from '@farmx/database';
import { authKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { AuditActor } from '../audit/index.js';
import {
  ACCESS_CACHE_TTL_SECONDS,
  type CreateRoleInput,
  type PermissionGroupView,
  type RoleAssignment,
  type RoleListQuery,
  type RoleView,
  SCOPES_WITH_ID,
  type SetRolePermissionsInput,
  type SetUserRolesInput,
  type SetUserRolesResult,
  type UpdateRoleInput,
  type UserAccess,
} from './access.types.js';
import { PERMISSION_CATALOG } from './permissions.catalog.js';

type Deps = Pick<
  Cradle,
  'accessRepository' | 'auditService' | 'redis' | 'logger' | 'runInTransaction'
>;

/** Bumped on ANY role/permission change: every cached access entry becomes stale in O(1). */
const RBAC_VERSION_KEY = authKeys.rbacVersion();

interface CachedAccess extends UserAccess {
  v: string;
}

const assignmentKey = (roleId: string, scopeType: string, scopeId: string | null) =>
  `${roleId}|${scopeType}|${scopeId ?? ''}`;

/** The fixed catalog, grouped for the admin UI (static: built once). */
const PERMISSION_GROUPS: readonly PermissionGroupView[] = PERMISSION_CATALOG.map((group) => ({
  module: group.module,
  label: group.label,
  permissions: group.permissions.map((p) => ({
    key: p.key,
    description: p.description,
    sensitive: p.sensitive ?? false,
    assignable: p.assignable ?? true,
    scopes: [...(p.scopes ?? ['GLOBAL'])],
  })),
}));

/**
 * Public API of the access feature (RBAC): permissions are FIXED (code), roles are DYNAMIC (DB).
 * Permission checks read a Redis-cached access summary (1 round trip); the DB is hit only on a
 * cache miss or after a change.
 */
export class AccessService {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  // ── Checks ───────────────────────────────────────────────────────────────────────────────

  /** Roles, GLOBAL permissions, MFA flag and idle timeout for a user (cached). */
  async getUserAccess(userId: string): Promise<UserAccess> {
    const { redis, logger, accessRepository } = this.deps;
    const cacheKey = authKeys.permissions(userId);
    let version = '0';
    try {
      const [v, cached] = await redis.mget(RBAC_VERSION_KEY, cacheKey);
      version = v ?? '0';
      if (typeof cached === 'string') {
        const parsed = JSON.parse(cached) as CachedAccess;
        if (parsed.v === version) {
          return {
            roles: parsed.roles,
            permissions: parsed.permissions,
            mfaRequired: parsed.mfaRequired,
            sessionIdleMinutes: parsed.sessionIdleMinutes,
          };
        }
      }
    } catch (err) {
      logger.warn({ err }, 'access cache unavailable; reading from the database');
    }

    const access = await accessRepository.loadUserAccess(userId, new Date());
    try {
      const value: CachedAccess = { ...access, v: version };
      await redis.set(cacheKey, JSON.stringify(value), 'EX', ACCESS_CACHE_TTL_SECONDS);
    } catch {
      // Cache write is best-effort.
    }
    return access;
  }

  /** Default deny: true only if an active GLOBAL assignment grants the permission. */
  async hasPermission(userId: string, permissionKey: string): Promise<boolean> {
    return (await this.getUserAccess(userId)).permissions.includes(permissionKey);
  }

  /** Drops one user's cached access (after their assignments changed and the tx committed). */
  async invalidateUser(userId: string): Promise<void> {
    try {
      await this.deps.redis.del(authKeys.permissions(userId));
    } catch (err) {
      this.deps.logger.warn(
        { err, userId },
        'failed to invalidate access cache; it expires by TTL',
      );
    }
  }

  /** Invalidates every user's cached access (role permissions / archive changed). */
  private async bumpVersion(): Promise<void> {
    try {
      await this.deps.redis.incr(RBAC_VERSION_KEY);
    } catch (err) {
      this.deps.logger.warn({ err }, 'failed to bump RBAC version; caches expire by TTL');
    }
  }

  // ── Permissions (read-only) ──────────────────────────────────────────────────────────────

  listPermissions(): readonly PermissionGroupView[] {
    return PERMISSION_GROUPS;
  }

  // ── Roles ────────────────────────────────────────────────────────────────────────────────

  listRoles(query: RoleListQuery): Promise<Paginated<RoleView>> {
    return this.deps.accessRepository.listRoles(query);
  }

  async getRole(id: string): Promise<RoleView> {
    const role = await this.deps.accessRepository.findRoleView(id);
    if (role === null) throw new NotFoundError('Role');
    return role;
  }

  async createRole(input: CreateRoleInput, actor: AuditActor): Promise<RoleView> {
    const { accessRepository, auditService, runInTransaction } = this.deps;
    const permissionIds = await this.assignablePermissionIds(input.permissions ?? []);
    try {
      const { id } = await runInTransaction(async (tx) => {
        const created = await accessRepository.createRole(
          {
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            audience: input.audience,
            mfaRequired: input.mfaRequired ?? true,
            sessionIdleMinutes: input.sessionIdleMinutes ?? null,
            createdByUserId: actor.userId,
          },
          permissionIds,
          tx,
        );
        await auditService.record(
          {
            actor,
            action: 'role.created',
            targetType: 'role',
            targetId: created.id,
            after: {
              key: input.key,
              name: input.name,
              audience: input.audience,
              permissions: [...(input.permissions ?? [])].sort(),
            },
            reason: input.reason ?? null,
          },
          tx,
        );
        return created;
      });
      return await this.getRole(id);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError(`Role key "${input.key}" already exists`);
      throw error;
    }
  }

  async updateRole(id: string, input: UpdateRoleInput, actor: AuditActor): Promise<RoleView> {
    const before = await this.getRole(id);
    this.assertMutable(before);
    const data = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.mfaRequired === undefined ? {} : { mfaRequired: input.mfaRequired }),
      ...(input.sessionIdleMinutes === undefined
        ? {}
        : { sessionIdleMinutes: input.sessionIdleMinutes }),
    };
    if (Object.keys(data).length === 0) return before;

    await this.deps.runInTransaction(async (tx) => {
      await this.deps.accessRepository.updateRole(
        id,
        { ...data, updatedByUserId: actor.userId },
        tx,
      );
      await this.deps.auditService.record(
        {
          actor,
          action: 'role.updated',
          targetType: 'role',
          targetId: id,
          before: {
            name: before.name,
            description: before.description,
            mfaRequired: before.mfaRequired,
            sessionIdleMinutes: before.sessionIdleMinutes,
          },
          after: data,
          reason: input.reason ?? null,
        },
        tx,
      );
    });
    // MFA flag and idle timeout are part of every holder's cached access.
    await this.bumpVersion();
    return this.getRole(id);
  }

  async archiveRole(id: string, reason: string, actor: AuditActor): Promise<RoleView> {
    const role = await this.getRole(id);
    this.assertMutable(role);
    if (role.archivedAt !== null) return role;
    await this.deps.runInTransaction(async (tx) => {
      await this.deps.accessRepository.updateRole(
        id,
        { archivedAt: new Date(), updatedByUserId: actor.userId },
        tx,
      );
      await this.deps.auditService.record(
        {
          actor,
          action: 'role.archived',
          targetType: 'role',
          targetId: id,
          before: { key: role.key },
          reason,
          metadata: { activeHolders: role.activeHolders },
        },
        tx,
      );
    });
    await this.bumpVersion();
    return this.getRole(id);
  }

  async setRolePermissions(
    id: string,
    input: SetRolePermissionsInput,
    actor: AuditActor,
  ): Promise<RoleView> {
    const role = await this.getRole(id);
    this.assertMutable(role);
    const permissionIds = await this.assignablePermissionIds(input.permissions);
    const after = [...new Set(input.permissions)].sort();

    await this.deps.runInTransaction(async (tx) => {
      await this.deps.accessRepository.replaceRolePermissions(id, permissionIds, actor.userId, tx);
      await this.deps.auditService.record(
        {
          actor,
          action: 'role.permissions_set',
          targetType: 'role',
          targetId: id,
          before: { permissions: role.permissions },
          after: { permissions: after },
          reason: input.reason,
          metadata: {
            granted: after.filter((key) => !role.permissions.includes(key)),
            revoked: role.permissions.filter((key) => !after.includes(key)),
          },
        },
        tx,
      );
    });
    await this.bumpVersion();
    return this.getRole(id);
  }

  // ── Assignments ──────────────────────────────────────────────────────────────────────────

  /** Active role assignments per user id (users without roles map to `[]`). One query. */
  async getRolesForUsers(
    userIds: readonly string[],
    tx?: Tx,
  ): Promise<Map<string, RoleAssignment[]>> {
    const rows = await this.deps.accessRepository.listActiveAssignments(userIds, new Date(), tx);
    const byUser = new Map<string, RoleAssignment[]>(userIds.map((id) => [id, []]));
    for (const { userId, assignment } of rows) byUser.get(userId)?.push(assignment);
    return byUser;
  }

  listActiveHolderIds(roleKey: string, tx?: Tx): Promise<string[]> {
    return this.deps.accessRepository.listActiveHolderIds(roleKey, new Date(), tx);
  }

  /** Transaction-scoped lock for "is this the last holder?" checks followed by changes. */
  lockRoleChanges(tx: Tx): Promise<void> {
    return this.deps.accessRepository.lockRoleChanges(tx);
  }

  /**
   * Makes the user's active assignments exactly `input.roles` (diff: unchanged ones are kept,
   * missing ones revoked, new ones created). Runs in the caller's transaction; the caller audits,
   * ends sessions and calls `invalidateUser` after commit.
   */
  async setUserRoles(input: SetUserRolesInput, tx: Tx): Promise<SetUserRolesResult> {
    const { accessRepository } = this.deps;
    const keys = [...new Set(input.roles.map((role) => role.roleKey))];
    const roles = await accessRepository.findActiveRolesByKeys(keys, tx);
    const byKey = new Map(roles.map((role) => [role.key, role]));

    const missing = keys.filter((key) => !byKey.has(key));
    if (missing.length > 0) throw new NotFoundError(`Role(s) ${missing.join(', ')}`);

    const desired = new Map<
      string,
      {
        roleId: string;
        scopeType: SetUserRolesInput['roles'][number]['scopeType'];
        scopeId: string | null;
      }
    >();
    for (const choice of input.roles) {
      const role = byKey.get(choice.roleKey);
      if (role === undefined) continue;
      if (role.audience !== input.userType) {
        throw new BadRequestError(
          `Role "${role.key}" is for ${role.audience} users, not ${input.userType}`,
        );
      }
      const scopeId = choice.scopeId ?? null;
      if (SCOPES_WITH_ID.includes(choice.scopeType) !== (scopeId !== null)) {
        throw new BadRequestError(
          `Role "${role.key}": scopeId is ${scopeId === null ? 'required' : 'not allowed'} for scope ${choice.scopeType}`,
        );
      }
      desired.set(assignmentKey(role.id, choice.scopeType, scopeId), {
        roleId: role.id,
        scopeType: choice.scopeType,
        scopeId,
      });
    }

    const now = new Date();
    const current = (await accessRepository.listActiveAssignments([input.userId], now, tx)).map(
      (row) => row.assignment,
    );
    const currentKeys = new Set(
      current.map((a) => assignmentKey(a.roleId, a.scopeType, a.scopeId)),
    );
    const removed = current.filter(
      (a) => !desired.has(assignmentKey(a.roleId, a.scopeType, a.scopeId)),
    );

    await accessRepository.revokeAssignments(
      removed.map((a) => a.id),
      input.actorUserId,
      input.reason,
      now,
      tx,
    );
    const added: RoleAssignment[] = [];
    for (const [key, choice] of desired) {
      if (currentKeys.has(key)) continue;
      added.push(
        await accessRepository.createAssignment(
          {
            userId: input.userId,
            ...choice,
            assignedByUserId: input.actorUserId,
            reason: input.reason,
          },
          tx,
        ),
      );
    }
    const kept = current.filter((a) => !removed.includes(a));
    return { added, removed, current: [...kept, ...added] };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────

  private assertMutable(role: RoleView): void {
    if (role.isSystem) throw new ConflictError(`System role "${role.key}" cannot be changed`);
  }

  /** Validates keys against the catalog: must exist, be active and be assignable to dynamic roles. */
  private async assignablePermissionIds(keys: readonly string[]): Promise<string[]> {
    const unique = [...new Set(keys)];
    const rows = await this.deps.accessRepository.findPermissionsByKeys(unique);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const unknown = unique.filter(
      (key) => byKey.get(key)?.deprecatedAt !== null || !byKey.has(key),
    );
    if (unknown.length > 0)
      throw new BadRequestError(`Unknown or deprecated permission(s): ${unknown.join(', ')}`);
    const reserved = unique.filter((key) => byKey.get(key)?.assignable === false);
    if (reserved.length > 0) {
      throw new BadRequestError(
        `Reserved for Super Admin, not assignable to roles: ${reserved.join(', ')}`,
      );
    }
    return unique.map((key) => byKey.get(key)?.id).filter((id): id is string => id !== undefined);
  }
}
