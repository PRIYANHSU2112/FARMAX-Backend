import type { Paginated } from '@farmx/common/types';
import { type Tx, advisoryXactLock, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  RoleAssignment,
  RoleAudience,
  RoleListQuery,
  RoleView,
  ScopeType,
  UserAccess,
} from './access.types.js';

const ROLE_CHANGE_LOCK = 'farmx-auth:role-changes';

/** An assignment counts while it is not revoked, not expired and its role is not archived. */
const activeAssignment = (now: Date): Prisma.UserRoleWhereInput => ({
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  role: { archivedAt: null },
});

const assignmentSelect = {
  id: true,
  userId: true,
  roleId: true,
  scopeType: true,
  scopeId: true,
  expiresAt: true,
  role: { select: { key: true, name: true } },
} satisfies Prisma.UserRoleSelect;

type AssignmentRow = Prisma.UserRoleGetPayload<{ select: typeof assignmentSelect }>;

const toAssignment = (row: AssignmentRow): RoleAssignment => ({
  id: row.id,
  roleId: row.roleId,
  roleKey: row.role.key,
  roleName: row.role.name,
  scopeType: row.scopeType,
  scopeId: row.scopeId,
  expiresAt: row.expiresAt?.toISOString() ?? null,
});

/** One query: role + its permission keys + count of active holders (no N+1). */
const roleSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  audience: true,
  isSystem: true,
  mfaRequired: true,
  sessionIdleMinutes: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
  permissions: { select: { permission: { select: { key: true } } } },
  _count: { select: { assignments: { where: { revokedAt: null } } } },
} satisfies Prisma.RoleSelect;

type RoleRow = Prisma.RoleGetPayload<{ select: typeof roleSelect }>;

const toRoleView = (row: RoleRow): RoleView => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  audience: row.audience,
  isSystem: row.isSystem,
  mfaRequired: row.mfaRequired,
  sessionIdleMinutes: row.sessionIdleMinutes,
  permissions: row.permissions.map((rp) => rp.permission.key).sort(),
  activeHolders: row._count.assignments,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  archivedAt: row.archivedAt?.toISOString() ?? null,
});

export interface RoleRecord {
  id: string;
  key: string;
  audience: RoleAudience;
  isSystem: boolean;
  archivedAt: Date | null;
}

export interface PermissionRecord {
  id: string;
  key: string;
  assignable: boolean;
  deprecatedAt: Date | null;
}

/** The only code that touches roles, permissions, role_permissions and user_roles. */
export class AccessRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Serialises role/holder changes until the transaction ends (lockout checks stay correct). */
  lockRoleChanges(tx: Tx): Promise<void> {
    return withPrismaErrors(() => advisoryXactLock(tx, ROLE_CHANGE_LOCK));
  }

  /**
   * Everything access checks need for one user, in ONE round trip: active assignments with their
   * role flags and non-deprecated permission keys. GLOBAL-scope assignments grant permissions.
   */
  async loadUserAccess(userId: string, now: Date): Promise<UserAccess> {
    const rows = await withPrismaErrors(() =>
      this.db.userRole.findMany({
        where: { userId, ...activeAssignment(now) },
        select: {
          scopeType: true,
          role: {
            select: {
              key: true,
              mfaRequired: true,
              sessionIdleMinutes: true,
              permissions: {
                where: { permission: { deprecatedAt: null } },
                select: { permission: { select: { key: true } } },
              },
            },
          },
        },
      }),
    );
    const permissions = new Set<string>();
    const idle = rows
      .map((row) => row.role.sessionIdleMinutes)
      .filter((m): m is number => m !== null);
    for (const row of rows) {
      if (row.scopeType !== 'GLOBAL') continue;
      for (const rp of row.role.permissions) permissions.add(rp.permission.key);
    }
    return {
      roles: [...new Set(rows.map((row) => row.role.key))].sort(),
      permissions: [...permissions].sort(),
      mfaRequired: rows.some((row) => row.role.mfaRequired),
      sessionIdleMinutes: idle.length > 0 ? Math.min(...idle) : null,
    };
  }

  // ── Roles ────────────────────────────────────────────────────────────────────────────────

  async listRoles(query: RoleListQuery): Promise<Paginated<RoleView>> {
    const q = query.q?.trim();
    const where: Prisma.RoleWhereInput = {
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.audience === undefined ? {} : { audience: query.audience }),
      ...(q === undefined || q === ''
        ? {}
        : {
            OR: [
              { key: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          }),
    };
    const rows = await withPrismaErrors(() =>
      this.db.role.findMany({
        where,
        select: roleSelect,
        orderBy: { id: 'asc' },
        ...cursorArgs(query),
      }),
    );
    return toPage(rows.map(toRoleView), query.limit);
  }

  async findRoleView(id: string): Promise<RoleView | null> {
    const row = await withPrismaErrors(() =>
      this.db.role.findUnique({ where: { id }, select: roleSelect }),
    );
    return row === null ? null : toRoleView(row);
  }

  async findRole(id: string, tx?: Tx): Promise<RoleRecord | null> {
    const db = tx ?? this.db;
    return withPrismaErrors(() =>
      db.role.findUnique({
        where: { id },
        select: { id: true, key: true, audience: true, isSystem: true, archivedAt: true },
      }),
    );
  }

  /** Active (non-archived) roles by key. */
  async findActiveRolesByKeys(keys: readonly string[], tx?: Tx): Promise<RoleRecord[]> {
    if (keys.length === 0) return [];
    const db = tx ?? this.db;
    return withPrismaErrors(() =>
      db.role.findMany({
        where: { key: { in: [...keys] }, archivedAt: null },
        select: { id: true, key: true, audience: true, isSystem: true, archivedAt: true },
      }),
    );
  }

  async createRole(
    data: {
      key: string;
      name: string;
      description: string | null;
      audience: RoleAudience;
      mfaRequired: boolean;
      sessionIdleMinutes: number | null;
      createdByUserId: string;
    },
    permissionIds: readonly string[],
    tx: Tx,
  ): Promise<{ id: string }> {
    return withPrismaErrors(() =>
      tx.role.create({
        data: {
          ...data,
          updatedByUserId: data.createdByUserId,
          permissions: {
            createMany: {
              data: permissionIds.map((permissionId) => ({
                permissionId,
                grantedByUserId: data.createdByUserId,
              })),
            },
          },
        },
        select: { id: true },
      }),
    );
  }

  async updateRole(id: string, data: Prisma.RoleUpdateInput, tx: Tx): Promise<void> {
    await withPrismaErrors(() => tx.role.update({ where: { id }, data, select: { id: true } }));
  }

  /** Replaces the role's permission set (diff: delete removed, insert added). */
  async replaceRolePermissions(
    roleId: string,
    permissionIds: readonly string[],
    grantedByUserId: string,
    tx: Tx,
  ): Promise<void> {
    await withPrismaErrors(async () => {
      await tx.rolePermission.deleteMany({
        where: { roleId, permissionId: { notIn: [...permissionIds] } },
      });
      await tx.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({ roleId, permissionId, grantedByUserId })),
        skipDuplicates: true,
      });
    });
  }

  // ── Permissions ──────────────────────────────────────────────────────────────────────────

  async findPermissionsByKeys(keys: readonly string[], tx?: Tx): Promise<PermissionRecord[]> {
    if (keys.length === 0) return [];
    const db = tx ?? this.db;
    return withPrismaErrors(() =>
      db.permission.findMany({
        where: { key: { in: [...keys] } },
        select: { id: true, key: true, assignable: true, deprecatedAt: true },
      }),
    );
  }

  // ── Assignments ──────────────────────────────────────────────────────────────────────────

  async listActiveAssignments(userIds: readonly string[], now: Date, tx?: Tx) {
    if (userIds.length === 0) return [];
    const db = tx ?? this.db;
    const rows = await withPrismaErrors(() =>
      db.userRole.findMany({
        where: { userId: { in: [...userIds] }, ...activeAssignment(now) },
        select: assignmentSelect,
        orderBy: { assignedAt: 'asc' },
      }),
    );
    return rows.map((row) => ({ userId: row.userId, assignment: toAssignment(row) }));
  }

  /** User ids with an active assignment of the role `roleKey`. */
  async listActiveHolderIds(roleKey: string, now: Date, tx?: Tx): Promise<string[]> {
    const db = tx ?? this.db;
    const rows = await withPrismaErrors(() =>
      db.userRole.findMany({
        where: { ...activeAssignment(now), role: { key: roleKey, archivedAt: null } },
        select: { userId: true },
        distinct: ['userId'],
      }),
    );
    return rows.map((row) => row.userId);
  }

  async revokeAssignments(
    ids: readonly string[],
    revokedByUserId: string,
    reason: string,
    now: Date,
    tx: Tx,
  ): Promise<void> {
    if (ids.length === 0) return;
    await withPrismaErrors(() =>
      tx.userRole.updateMany({
        where: { id: { in: [...ids] }, revokedAt: null },
        data: { revokedAt: now, revokedByUserId, reason },
      }),
    );
  }

  async createAssignment(
    data: {
      userId: string;
      roleId: string;
      scopeType: ScopeType;
      scopeId: string | null;
      assignedByUserId: string;
      reason: string;
    },
    tx: Tx,
  ): Promise<RoleAssignment> {
    const row = await withPrismaErrors(() =>
      tx.userRole.create({ data, select: assignmentSelect }),
    );
    return toAssignment(row);
  }
}
