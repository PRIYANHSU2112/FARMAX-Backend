import { ConflictError, ForbiddenError, NotFoundError, RateLimitError } from '@farmx/common/errors';
import { isUniqueViolation } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { RoleAssignment } from '../access/index.js';
import type { AuditActor } from '../audit/index.js';
import type { LoginUserRecord } from '../users/index.js';
import {
  type InviteStaffInput,
  type InviteStaffResult,
  type ResendInvitationInput,
  type RevokeStaffInput,
  TEAM_MANAGE_PERMISSION,
} from './staff.types.js';

type Deps = Pick<
  Cradle,
  | 'usersService'
  | 'accessService'
  | 'authService'
  | 'sessionsService'
  | 'auditService'
  | 'runInTransaction'
>;

const INVITABLE_STATUSES = new Set(['ACTIVE', 'PENDING_VERIFICATION']);

/** P2002 raw, or already mapped to a 409 by withPrismaErrors (the Prisma error is its cause). */
const isUniqueRace = (error: unknown): boolean =>
  isUniqueViolation(error) || (error instanceof Error && isUniqueViolation(error.cause));

const roleSnapshot = (a: RoleAssignment) => ({
  roleKey: a.roleKey,
  scopeType: a.scopeType,
  scopeId: a.scopeId,
});

/**
 * Warehouse staff (D-56), called by warehouse-service over `/internal/staff/*`. Staff accounts are
 * invite-only. Rules enforced HERE (not only in warehouse-service):
 *  - the caller holds `warehouse.team_manage` at that warehouse (GLOBAL or WAREHOUSE grant);
 *  - the role is a warehouse template and grants nothing the caller lacks there (no escalation);
 *  - nobody removes their own access.
 * Granting adds access, so it only refreshes the cached permissions; revoking also ends sessions.
 */
export class StaffService {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  async invite(input: InviteStaffInput, retried = false): Promise<InviteStaffResult> {
    const { usersService, accessService, auditService, runInTransaction } = this.deps;
    const email = input.email.trim().toLowerCase();
    const callerPermissions = await this.requireTeamManager(
      input.invitedByUserId,
      input.warehouseId,
    );
    const template = await accessService.requireWarehouseRoleTemplate(input.roleId);
    this.assertNoEscalation(template.permissions, callerPermissions);

    const existing = await usersService.findLoginUser(email);
    if (existing !== null) this.assertInvitable(existing);

    const actor = this.actor(input.invitedByUserId, input.requestId);
    let outcome: { user: LoginUserRecord; created: boolean; granted: boolean };
    try {
      outcome = await runInTransaction(async (tx) => {
        const user =
          existing ??
          (await usersService.createInvitedStaff(
            { email, fullName: input.fullName.trim(), createdByUserId: input.invitedByUserId },
            tx,
          ));
        const { assignment, added } = await accessService.grantWarehouseRole(
          {
            userId: user.id,
            roleId: template.id,
            warehouseId: input.warehouseId,
            actorUserId: input.invitedByUserId,
            reason: input.reason ?? 'warehouse team: employee added',
          },
          tx,
        );
        if (existing === null || added) {
          await auditService.record(
            {
              actor,
              action: existing === null ? 'user.invited' : 'user_role.changed',
              targetType: 'user',
              targetId: user.id,
              subjectUserId: user.id,
              after: { role: roleSnapshot(assignment) },
              reason: input.reason ?? null,
              metadata: { source: 'warehouse_team', newAccount: existing === null },
            },
            tx,
          );
        }
        return { user, created: existing === null, granted: added };
      });
    } catch (error) {
      // Two invitations at once (same new email, or same role grant): the loser re-reads and
      // joins the winner's account / assignment.
      if (!retried && isUniqueRace(error)) return this.invite(input, true);
      throw error;
    }

    if (outcome.granted) await accessService.invalidateUser(outcome.user.id);
    const invitationSent =
      outcome.user.status === 'PENDING_VERIFICATION'
        ? await this.invitationFor(outcome.user)
        : false;
    return {
      userId: outcome.user.id,
      created: outcome.created,
      granted: outcome.granted,
      invitationSent,
      status: outcome.user.status,
    };
  }

  /** New code for a member who has not accepted yet. 429 inside the resend cooldown. */
  async resendInvitation(input: ResendInvitationInput): Promise<{ invitationSent: boolean }> {
    await this.requireTeamManager(input.requestedByUserId, input.warehouseId);
    const user = await this.requireMember(input.userId, input.warehouseId);
    if (user.status !== 'PENDING_VERIFICATION')
      throw new ConflictError('This person has already accepted the invitation');
    const invitationSent = await this.deps.authService.sendStaffInvitation(user);
    if (invitationSent) {
      await this.deps.auditService.record({
        actor: this.actor(input.requestedByUserId, input.requestId),
        action: 'user.invitation_resent',
        targetType: 'user',
        targetId: user.id,
        subjectUserId: user.id,
        metadata: { warehouseId: input.warehouseId },
      });
    }
    return { invitationSent };
  }

  /**
   * Removes a member's roles at one warehouse (or one role). Ends their sessions so the next
   * token reflects it; the account itself stays (it may hold other warehouses).
   */
  async revoke(input: RevokeStaffInput): Promise<{ revoked: number }> {
    if (input.userId === input.revokedByUserId)
      throw new ForbiddenError('You cannot remove your own access');
    const { accessService, sessionsService, auditService, runInTransaction } = this.deps;
    const callerPermissions = await this.requireTeamManager(
      input.revokedByUserId,
      input.warehouseId,
    );
    const member = (await accessService.listScopeMembers('WAREHOUSE', input.warehouseId)).find(
      (m) => m.userId === input.userId,
    );
    const targeted = (member?.roles ?? []).filter(
      (role) => input.roleId === undefined || role.roleId === input.roleId,
    );
    if (targeted.length === 0) throw new NotFoundError('Team member');
    // Removing a role you could not grant is refused too (same anti-escalation rule).
    for (const role of targeted) {
      const view = await accessService.getRole(role.roleId);
      this.assertNoEscalation(view.permissions, callerPermissions);
    }

    const { removed, sessions } = await runInTransaction(async (tx) => {
      const removedRoles = await accessService.revokeWarehouseRoles(
        {
          userId: input.userId,
          warehouseId: input.warehouseId,
          roleId: input.roleId ?? null,
          actorUserId: input.revokedByUserId,
          reason: input.reason,
        },
        tx,
      );
      if (removedRoles.length === 0) return { removed: removedRoles, sessions: [] };
      const revokedSessions = await sessionsService.revokeAllForUser(
        input.userId,
        'ROLE_CHANGED',
        tx,
      );
      await auditService.record(
        {
          actor: this.actor(input.revokedByUserId, input.requestId),
          action: 'user_role.changed',
          targetType: 'user',
          targetId: input.userId,
          subjectUserId: input.userId,
          before: { roles: removedRoles.map(roleSnapshot) },
          after: { roles: [] },
          reason: input.reason,
          metadata: {
            source: 'warehouse_team',
            warehouseId: input.warehouseId,
            revokedSessions: revokedSessions.length,
          },
        },
        tx,
      );
      return { removed: removedRoles, sessions: revokedSessions };
    });
    if (removed.length > 0) {
      await accessService.invalidateUser(input.userId);
      await sessionsService.publishRevocations(sessions);
    }
    return { revoked: removed.length };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────

  /**
   * The account and the role are already saved, so a code still inside its resend cooldown (a
   * repeated "Add employee") is not an error here: the response says no new code was sent and the
   * explicit "Resend invitation" action reports the wait.
   */
  private async invitationFor(user: LoginUserRecord): Promise<boolean> {
    try {
      return await this.deps.authService.sendStaffInvitation(user);
    } catch (error) {
      if (error instanceof RateLimitError) return false;
      throw error;
    }
  }

  /** The caller's permissions at the warehouse; 403 without `warehouse.team_manage` there. */
  private async requireTeamManager(userId: string, warehouseId: string): Promise<Set<string>> {
    const permissions = await this.deps.accessService.permissionsAt(userId, warehouseId);
    if (!permissions.has(TEAM_MANAGE_PERMISSION))
      throw new ForbiddenError('You cannot manage the team of this warehouse');
    return permissions;
  }

  private assertNoEscalation(rolePermissions: readonly string[], caller: Set<string>): void {
    const beyond = rolePermissions.filter((key) => !caller.has(key));
    if (beyond.length > 0) {
      throw new ForbiddenError('This role grants permissions you do not hold at this warehouse', {
        details: { reason: 'PRIVILEGE_ESCALATION', permissions: beyond },
      });
    }
  }

  /** Only live staff accounts can be invited; never reveals what other kind of account it is. */
  private assertInvitable(user: LoginUserRecord): void {
    if (
      user.userType !== 'INTERNAL' ||
      user.deletedAt !== null ||
      !INVITABLE_STATUSES.has(user.status)
    )
      throw new ConflictError('This email cannot be used for a staff account');
  }

  /** The user must currently hold a role at the warehouse (no codes for strangers). */
  private async requireMember(userId: string, warehouseId: string): Promise<LoginUserRecord> {
    const members = await this.deps.accessService.listScopeMembers('WAREHOUSE', warehouseId);
    const user = members.some((m) => m.userId === userId)
      ? await this.deps.usersService.findLoginUserById(userId)
      : null;
    if (user?.deletedAt !== null) throw new NotFoundError('Team member');
    return user;
  }

  private actor(userId: string, requestId: string | undefined): AuditActor {
    return { userId, ip: null, userAgent: null, requestId: requestId ?? null };
  }
}
