import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Cradle } from '@fastify/awilix';

import { type Tx, isUniqueViolation } from '@farmx/database';

import { emitAuthEvent } from '../../adapters/events.js';
import type { RoleAssignment, SetUserRolesResult } from '../access/index.js';
import { SUPER_ADMIN_ROLE } from '../access/index.js';
import type { AuditActor, JsonObject } from '../audit/index.js';
import type { SessionView } from '../sessions/index.js';
import type { UpdateUserData } from './users.repository.js';
import {
  type ChangeStatusInput,
  type CreateUserInput,
  type ForceLogoutResult,
  type LoginUserRecord,
  type MeView,
  MFA_MANDATORY_TYPES,
  type SetRolesInput,
  type UpdateUserInput,
  type UserContact,
  type UserListQuery,
  type UserRecord,
  type UserType,
  type UserView,
} from './users.types.js';

type Deps = Pick<
  Cradle,
  | 'usersRepository'
  | 'accessService'
  | 'credentialsService'
  | 'mfaService'
  | 'sessionsService'
  | 'auditService'
  | 'runInTransaction'
>;

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

const toView = (user: UserRecord, roles: readonly RoleAssignment[]): UserView => ({
  id: user.id,
  userType: user.userType,
  email: user.email,
  emailVerified: user.emailVerifiedAt !== null,
  phone: user.phone,
  phoneVerified: user.phoneVerifiedAt !== null,
  username: user.username,
  fullName: user.fullName,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
  employeeCode: user.employeeCode,
  preferredLanguage: user.preferredLanguage,
  timezone: user.timezone,
  status: user.status,
  statusReason: user.statusReason,
  statusChangedAt: iso(user.statusChangedAt),
  mfaRequired: user.mfaRequired,
  mustChangePassword: user.mustChangePassword,
  lastLoginAt: iso(user.lastLoginAt),
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
  deletedAt: iso(user.deletedAt),
  roles: roles.map((role) => ({
    roleKey: role.roleKey,
    roleName: role.roleName,
    scopeType: role.scopeType,
    scopeId: role.scopeId,
    expiresAt: role.expiresAt,
  })),
});

/** Audit snapshot of the fields admins manage. Never credentials. */
const snapshot = (user: UserRecord): JsonObject => ({
  userType: user.userType,
  email: user.email,
  phone: user.phone,
  username: user.username,
  fullName: user.fullName,
  employeeCode: user.employeeCode,
  status: user.status,
  mfaRequired: user.mfaRequired,
});

const roleSnapshot = (role: RoleAssignment): JsonObject => ({
  roleKey: role.roleKey,
  scopeType: role.scopeType,
  scopeId: role.scopeId,
});

const EDITABLE_FIELDS = [
  'email',
  'phone',
  'username',
  'fullName',
  'displayName',
  'avatarUrl',
  'employeeCode',
  'preferredLanguage',
  'timezone',
  'mfaRequired',
] as const satisfies readonly (keyof UpdateUserInput & keyof UserRecord)[];

/**
 * Public API of the users module: admin user management.
 *
 * Every mutation runs in ONE transaction with its audit row (audit module) and, where access
 * must end, the revocation of the user's sessions (sessions module). Revoked session ids are
 * pushed to Redis after commit so the gateway blocks live access tokens immediately.
 */
export class UsersService {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  // ── Internal (notification-service) ───────────────────────────────────────────────────

  getContact(id: string): Promise<UserContact | null> {
    return this.deps.usersRepository.findContact(id);
  }

  /** Many contacts in one query (warehouse-service team list, manager names). */
  getContacts(ids: readonly string[]): Promise<UserContact[]> {
    return this.deps.usersRepository.findContacts(ids);
  }

  /**
   * A warehouse invitation for an unknown email (D-56): INTERNAL, PENDING_VERIFICATION, no
   * password and no phone (phones are unique across ALL users; the warehouse keeps its own copy).
   * The invitation code proves the email when the person accepts.
   */
  async createInvitedStaff(
    input: { email: string; fullName: string; createdByUserId: string },
    tx: Tx,
  ): Promise<LoginUserRecord> {
    const created = await this.deps.usersRepository.create(
      {
        userType: 'INTERNAL',
        email: input.email,
        phone: null,
        username: null,
        fullName: input.fullName,
        displayName: null,
        employeeCode: null,
        status: 'PENDING_VERIFICATION',
        statusChangedAt: new Date(),
        mfaRequired: MFA_MANDATORY_TYPES.includes('INTERNAL'),
        mustChangePassword: false,
        createdByUserId: input.createdByUserId,
        registrationSource: 'warehouse_invite',
      },
      tx,
    );
    return {
      id: created.id,
      userType: created.userType,
      status: created.status,
      deletedAt: created.deletedAt,
      mfaRequired: created.mfaRequired,
      mustChangePassword: created.mustChangePassword,
      email: created.email,
      phone: created.phone,
      username: created.username,
      fullName: created.fullName,
    };
  }

  /** Invitation accepted: the email is proven and the account becomes ACTIVE. */
  async activateInvitedStaff(userId: string, tx: Tx): Promise<void> {
    const now = new Date();
    await this.deps.usersRepository.update(
      userId,
      { status: 'ACTIVE', statusReason: null, statusChangedAt: now, emailVerifiedAt: now },
      tx,
    );
  }

  listActiveIds(userType: UserType, cursor: string | undefined, limit: number): Promise<string[]> {
    return this.deps.usersRepository.listActiveIds(userType, cursor, limit);
  }

  filterActiveIds(ids: readonly string[], userType: UserType): Promise<string[]> {
    return this.deps.usersRepository.filterActiveIds(ids, userType);
  }

  async list(query: UserListQuery): Promise<Paginated<UserView>> {
    const page = await this.deps.usersRepository.list(query);
    const roles = await this.deps.accessService.getRolesForUsers(page.items.map((user) => user.id));
    return { ...page, items: page.items.map((user) => toView(user, roles.get(user.id) ?? [])) };
  }

  /** Returns soft-deleted users too (with `deletedAt`), for the admin detail screen. */
  async get(id: string): Promise<UserView> {
    const user = await this.deps.usersRepository.findById(id);
    if (user === null) throw new NotFoundError('User');
    return this.view(user);
  }

  async create(input: CreateUserInput, actor: AuditActor): Promise<UserView> {
    const { usersRepository, accessService, credentialsService, auditService } = this.deps;
    const initialRoles = input.roles ?? [];
    if (
      initialRoles.length > 0 &&
      !(await accessService.hasPermission(actor.userId, 'roles.assign'))
    ) {
      throw new ForbiddenError('Assigning roles requires the roles.assign permission');
    }

    const email = input.email?.trim().toLowerCase();
    const username = input.username?.trim().toLowerCase();
    const mfaRequired =
      MFA_MANDATORY_TYPES.includes(input.userType) || (input.mfaRequired ?? false);
    // Hash before the transaction: Argon2id is deliberately slow.
    const passwordHash =
      input.temporaryPassword === undefined
        ? null
        : await credentialsService.hashNewPassword(
            input.temporaryPassword,
            [email, email?.split('@')[0], input.phone, username].filter(
              (v): v is string => v !== undefined,
            ),
            'temporaryPassword',
          );
    const now = new Date();

    const user = await this.deps.runInTransaction(async (tx) => {
      const created = await usersRepository.create(
        {
          userType: input.userType,
          email: email ?? null,
          phone: input.phone ?? null,
          username: username ?? null,
          fullName: input.fullName,
          displayName: input.displayName ?? null,
          employeeCode: input.employeeCode ?? null,
          ...(input.preferredLanguage === undefined
            ? {}
            : { preferredLanguage: input.preferredLanguage }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
          // With a temporary password the account is usable now (forced change at first login);
          // without one it waits for identifier verification / password setup.
          status: passwordHash === null ? 'PENDING_VERIFICATION' : 'ACTIVE',
          statusChangedAt: now,
          mfaRequired,
          mustChangePassword: passwordHash !== null,
          createdByUserId: actor.userId,
          registrationSource: 'admin',
        },
        tx,
      );
      if (passwordHash !== null)
        await credentialsService.storeInitialPassword(created.id, passwordHash, tx);

      let assigned: RoleAssignment[] = [];
      if (initialRoles.length > 0) {
        ({ added: assigned } = await accessService.setUserRoles(
          {
            userId: created.id,
            userType: created.userType,
            roles: initialRoles,
            actorUserId: actor.userId,
            reason: input.reason ?? 'initial roles at user creation',
          },
          tx,
        ));
      }

      await auditService.record(
        {
          actor,
          action: 'user.created',
          targetType: 'user',
          targetId: created.id,
          subjectUserId: created.id,
          after: { ...snapshot(created), roles: assigned.map(roleSnapshot) },
          reason: input.reason ?? null,
          metadata: { temporaryPassword: passwordHash !== null },
        },
        tx,
      );
      return created;
    });

    return this.view(user);
  }

  async update(id: string, input: UpdateUserInput, actor: AuditActor): Promise<UserView> {
    const current = await this.requireLive(id);
    const desired: UpdateUserInput = {
      ...input,
      ...(input.email === undefined ? {} : { email: input.email.trim().toLowerCase() }),
      ...(input.username === undefined ? {} : { username: input.username.trim().toLowerCase() }),
    };
    if (desired.mfaRequired === false && MFA_MANDATORY_TYPES.includes(current.userType)) {
      throw new BadRequestError(`MFA is mandatory for ${current.userType} users`);
    }

    const data: UpdateUserData = {};
    const before: JsonObject = {};
    const after: JsonObject = {};
    for (const field of EDITABLE_FIELDS) {
      const next = desired[field];
      if (next === undefined || next === current[field]) continue;
      before[field] = current[field];
      after[field] = next;
      Object.assign(data, { [field]: next });
    }
    if (Object.keys(data).length === 0) return this.view(current);
    // A changed identifier must be verified again.
    if (data.email !== undefined) data.emailVerifiedAt = null;
    if (data.phone !== undefined) data.phoneVerifiedAt = null;

    const user = await this.deps.runInTransaction(async (tx) => {
      const updated = await this.deps.usersRepository.update(id, data, tx);
      await this.deps.auditService.record(
        {
          actor,
          action: 'user.updated',
          targetType: 'user',
          targetId: id,
          subjectUserId: id,
          before,
          after,
          reason: input.reason ?? null,
        },
        tx,
      );
      return updated;
    });
    return this.view(user);
  }

  /**
   * Makes the user's roles exactly `input.roles` (diff-based). Ends the user's sessions so new
   * tokens carry the new roles; refuses to remove the last active Super Admin.
   */
  async setRoles(id: string, input: SetRolesInput, actor: AuditActor): Promise<UserView> {
    if (id === actor.userId) throw new ForbiddenError('You cannot change your own roles');
    const { accessService, sessionsService, auditService } = this.deps;
    const user = await this.requireLive(id);
    const keepsSuperAdmin = input.roles.some((role) => role.roleKey === SUPER_ADMIN_ROLE.key);

    const { result, revokedSessions } = await this.deps.runInTransaction(async (tx) => {
      await accessService.lockRoleChanges(tx);
      if (!keepsSuperAdmin) await this.assertNotLastSuperAdmin(id, tx);

      const changes: SetUserRolesResult = await accessService.setUserRoles(
        {
          userId: id,
          userType: user.userType,
          roles: input.roles,
          actorUserId: actor.userId,
          reason: input.reason,
        },
        tx,
      );
      const changed = changes.added.length > 0 || changes.removed.length > 0;
      const sessions = changed
        ? await sessionsService.revokeAllForUser(id, 'ROLE_CHANGED', tx)
        : [];
      if (changed) {
        const kept = changes.current.filter((a) => !changes.added.includes(a));
        await auditService.record(
          {
            actor,
            action: 'user_role.changed',
            targetType: 'user',
            targetId: id,
            subjectUserId: id,
            before: { roles: [...kept, ...changes.removed].map(roleSnapshot) },
            after: { roles: changes.current.map(roleSnapshot) },
            reason: input.reason,
            metadata: {
              added: changes.added.length,
              removed: changes.removed.length,
              revokedSessions: sessions.length,
            },
          },
          tx,
        );
      }
      return { result: changes, revokedSessions: sessions };
    });

    await accessService.invalidateUser(id);
    await sessionsService.publishRevocations(revokedSessions);
    return toView(user, result.current);
  }

  /** Block = SUSPENDED (ends all sessions); unblock = ACTIVE. Thin wrappers over changeStatus. */
  block(id: string, reason: string, actor: AuditActor): Promise<UserView> {
    return this.changeStatus(id, { status: 'SUSPENDED', reason }, actor);
  }

  unblock(id: string, reason: string, actor: AuditActor): Promise<UserView> {
    return this.changeStatus(id, { status: 'ACTIVE', reason }, actor);
  }

  /** Live sessions of a user (admin monitoring). */
  async listSessions(id: string): Promise<SessionView[]> {
    await this.requireExisting(id);
    return this.deps.sessionsService.listForUser(id);
  }

  // ── Self-service and login support (used by the auth feature) ─────────────────────────────

  async getMe(userId: string): Promise<MeView> {
    const user = await this.requireLive(userId);
    const [access, roles, mfaEnabled] = await Promise.all([
      this.deps.accessService.getUserAccess(userId),
      this.deps.accessService.getRolesForUsers([userId]),
      this.deps.mfaService.hasActiveTotp(userId),
    ]);
    return {
      ...toView(user, roles.get(userId) ?? []),
      permissions: access.permissions,
      mfaEnabled,
      mfaRequired: user.mfaRequired || access.mfaRequired,
    };
  }

  /** Login identifier: email (has @), phone (+E.164) or username. Unique, indexed lookups. */
  findLoginUser(identifier: string): Promise<LoginUserRecord | null> {
    const value = identifier.trim();
    const { usersRepository } = this.deps;
    if (value.includes('@')) return usersRepository.findLoginUser({ email: value.toLowerCase() });
    if (value.startsWith('+')) return usersRepository.findLoginUser({ phone: value });
    return usersRepository.findLoginUser({ username: value.toLowerCase() });
  }

  findLoginUserById(id: string): Promise<LoginUserRecord | null> {
    return this.deps.usersRepository.findLoginUser({ id });
  }

  /**
   * Customer OTP login: the phone is proven. Existing user → verify the phone (activating a
   * pending account); unknown → create an ACTIVE customer. Race-safe on the unique phone.
   */
  async findOrCreateByVerifiedPhone(
    phone: string,
  ): Promise<{ user: LoginUserRecord; created: boolean }> {
    const { usersRepository } = this.deps;
    const now = new Date();
    const existing = await usersRepository.findLoginUser({ phone });
    if (existing !== null) {
      const pending = existing.status === 'PENDING_VERIFICATION';
      if (existing.deletedAt === null)
        await usersRepository.markPhoneVerified(existing.id, pending, now);
      return {
        user: { ...existing, status: pending ? 'ACTIVE' : existing.status },
        created: false,
      };
    }
    try {
      return { user: await usersRepository.createSelfCustomer(phone, now), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await usersRepository.findLoginUser({ phone });
      if (raced === null) throw error;
      return { user: raced, created: false };
    }
  }

  recordLogin(userId: string, ip: string | null, deviceId: string | null): Promise<void> {
    return this.deps.usersRepository.recordLogin(userId, ip, deviceId, new Date());
  }

  clearMustChangePassword(userId: string, tx?: Tx): Promise<void> {
    return this.deps.usersRepository.setMustChangePassword(userId, false, tx);
  }

  /** ACTIVE / SUSPENDED / DEACTIVATED. Anything but ACTIVE ends all of the user's sessions. */
  async changeStatus(id: string, input: ChangeStatusInput, actor: AuditActor): Promise<UserView> {
    if (id === actor.userId) throw new ForbiddenError('You cannot change your own status');
    const current = await this.requireLive(id);
    if (current.status === input.status) return this.view(current);
    const { accessService, sessionsService, auditService, usersRepository } = this.deps;

    const { user, revokedSessions } = await this.deps.runInTransaction(async (tx) => {
      await accessService.lockRoleChanges(tx);
      if (input.status !== 'ACTIVE') await this.assertNotLastSuperAdmin(id, tx);

      const updated = await usersRepository.update(
        id,
        { status: input.status, statusReason: input.reason, statusChangedAt: new Date() },
        tx,
      );
      const sessions =
        input.status === 'ACTIVE'
          ? []
          : await sessionsService.revokeAllForUser(id, 'USER_SUSPENDED', tx);
      await auditService.record(
        {
          actor,
          action: 'user.status_changed',
          targetType: 'user',
          targetId: id,
          subjectUserId: id,
          before: { status: current.status },
          after: { status: input.status },
          reason: input.reason,
          metadata: { revokedSessions: sessions.length },
        },
        tx,
      );
      await emitAuthEvent(
        tx,
        'user.status_changed.v1',
        {
          userId: id,
          previousStatus: current.status,
          status: input.status,
          changedByUserId: actor.userId,
        },
        id,
      );
      return { user: updated, revokedSessions: sessions };
    });

    await sessionsService.publishRevocations(revokedSessions);
    return this.view(user);
  }

  /** Soft delete: sets deletedAt + DEACTIVATED and ends all sessions. Identifiers stay reserved. */
  async softDelete(id: string, reason: string, actor: AuditActor): Promise<void> {
    if (id === actor.userId) throw new ForbiddenError('You cannot delete your own account');
    const current = await this.requireLive(id);
    const { accessService, sessionsService, auditService, usersRepository } = this.deps;

    const revokedSessions = await this.deps.runInTransaction(async (tx) => {
      await accessService.lockRoleChanges(tx);
      await this.assertNotLastSuperAdmin(id, tx);

      const now = new Date();
      await usersRepository.update(
        id,
        { deletedAt: now, status: 'DEACTIVATED', statusReason: reason, statusChangedAt: now },
        tx,
      );
      const sessions = await sessionsService.revokeAllForUser(id, 'USER_SUSPENDED', tx);
      await auditService.record(
        {
          actor,
          action: 'user.deleted',
          targetType: 'user',
          targetId: id,
          subjectUserId: id,
          before: snapshot(current),
          reason,
          metadata: { revokedSessions: sessions.length },
        },
        tx,
      );
      await emitAuthEvent(tx, 'user.deleted.v1', { userId: id, deletedByUserId: actor.userId }, id);
      return sessions;
    });

    await sessionsService.publishRevocations(revokedSessions);
  }

  // ── Self-service deletion (deletion feature; always inside the caller's transaction) ──

  /** Login lookup by phone (account recovery). */
  findByPhone(phone: string): Promise<LoginUserRecord | null> {
    return this.deps.usersRepository.findLoginUser({ phone });
  }

  /** A live (not deleted) user, or null. */
  async findLive(id: string, tx?: Tx): Promise<UserRecord | null> {
    const user = await this.deps.usersRepository.findById(id, tx);
    return user?.deletedAt === null ? user : null;
  }

  /** ACTIVE ⇄ PENDING_DELETION, with its user.status_changed.v1 event. */
  async setDeletionStatus(
    tx: Tx,
    id: string,
    from: UserRecord['status'],
    to: 'PENDING_DELETION' | 'ACTIVE',
    reason: string,
  ): Promise<void> {
    await this.deps.usersRepository.update(
      id,
      { status: to, statusReason: reason, statusChangedAt: new Date() },
      tx,
    );
    await emitAuthEvent(
      tx,
      'user.status_changed.v1',
      { userId: id, previousStatus: from, status: to, changedByUserId: id },
      id,
    );
  }

  /**
   * Purge after the grace period: personal fields erased, identifiers released, account closed
   * (DEACTIVATED + deletedAt). Emits user.deleted.v1 so every service scrubs its copies.
   */
  async anonymise(tx: Tx, id: string): Promise<void> {
    const now = new Date();
    await this.deps.usersRepository.update(
      id,
      {
        // users_email_or_phone_chk needs one identifier: a unique, non-routable tombstone (RFC 2606
        // `.invalid`) — no personal data, and the real phone / email are free to register again.
        email: `deleted-${id}@deleted.invalid`,
        emailVerifiedAt: null,
        phone: null,
        phoneVerifiedAt: null,
        username: null,
        fullName: 'Deleted user',
        displayName: null,
        avatarUrl: null,
        employeeCode: null,
        status: 'DEACTIVATED',
        statusReason: 'self-service deletion',
        statusChangedAt: now,
        deletedAt: now,
      },
      tx,
    );
    await emitAuthEvent(tx, 'user.deleted.v1', { userId: id, deletedByUserId: id }, id);
  }

  /** Ends every session of the user (refresh tokens dead, access tokens blocked at the gateway). */
  async forceLogout(id: string, reason: string, actor: AuditActor): Promise<ForceLogoutResult> {
    await this.requireLive(id);
    const { sessionsService, auditService } = this.deps;

    const revokedSessions = await this.deps.runInTransaction(async (tx) => {
      const sessions = await sessionsService.revokeAllForUser(id, 'ADMIN', tx);
      await auditService.record(
        {
          actor,
          action: 'session.force_logout',
          targetType: 'user',
          targetId: id,
          subjectUserId: id,
          reason,
          metadata: { revokedSessions: sessions.length },
        },
        tx,
      );
      return sessions;
    });

    const accessTokensBlocked = await sessionsService.publishRevocations(revokedSessions);
    return { revokedSessions: revokedSessions.length, accessTokensBlocked };
  }

  private async requireExisting(id: string): Promise<UserRecord> {
    const user = await this.deps.usersRepository.findById(id);
    if (user === null) throw new NotFoundError('User');
    return user;
  }

  private async requireLive(id: string): Promise<UserRecord> {
    const user = await this.deps.usersRepository.findById(id);
    if (user === null) throw new NotFoundError('User');
    if (user.deletedAt !== null) throw new NotFoundError('User');
    return user;
  }

  private async view(user: UserRecord): Promise<UserView> {
    const roles = await this.deps.accessService.getRolesForUsers([user.id]);
    return toView(user, roles.get(user.id) ?? []);
  }

  /** Refuses a change that would leave no ACTIVE Super Admin (lockout protection). */
  private async assertNotLastSuperAdmin(userId: string, tx: Tx): Promise<void> {
    const holders = await this.deps.accessService.listActiveHolderIds(SUPER_ADMIN_ROLE.key, tx);
    if (!holders.includes(userId)) return;
    const others = holders.filter((holder) => holder !== userId);
    if ((await this.deps.usersRepository.countActive(others, tx)) === 0) {
      throw new ConflictError(
        'This is the last active Super Admin. Assign another Super Admin first.',
      );
    }
  }
}
