import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  RateLimitError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { authKeys } from '@farmx/infra/redis';
import { describe, expect, it, vi } from 'vitest';

import { AccessService } from '../../src/features/access/access.service.js';
import { AuthService } from '../../src/features/auth/auth.service.js';
import { StaffService } from '../../src/features/staff/staff.service.js';
import type { LoginUserRecord } from '../../src/features/users/index.js';
import { FakeRedis } from '../helpers/fake-redis.js';

const tx = {} as Tx;
const W1 = '0193a5f2-7c1e-7b2a-9f00-00000000a001';
const W2 = '0193a5f2-7c1e-7b2a-9f00-00000000a002';
const meta = { ip: '203.0.113.10', userAgent: 'test' };

const pendingStaff: LoginUserRecord = {
  id: 'u-new',
  userType: 'INTERNAL',
  status: 'PENDING_VERIFICATION',
  deletedAt: null,
  mfaRequired: true,
  mustChangePassword: false,
  email: 'priya@farmx.in',
  phone: null,
  username: null,
  fullName: 'Priya Menon',
};

// ── AccessService: WAREHOUSE-scoped grants (D-56) ────────────────────────────────────────

function accessSetup() {
  const redis = new FakeRedis();
  const accessRepository = {
    loadUserAccess: vi.fn(() =>
      Promise.resolve({
        roles: ['picker', 'viewer'],
        permissions: ['dashboard.view'],
        warehouses: { [W1]: ['inventory.pick', 'warehouse.view'] },
        mfaRequired: false,
        sessionIdleMinutes: null,
      }),
    ),
    listInternalRolesWithScopes: vi.fn(() =>
      Promise.resolve([
        {
          id: 'r-picker',
          key: 'picker',
          name: 'Picker',
          description: null,
          permissions: [
            { key: 'inventory.pick', allowedScopes: ['GLOBAL', 'REGION', 'WAREHOUSE'] },
          ],
        },
        {
          id: 'r-finance',
          key: 'finance',
          name: 'Finance',
          description: null,
          permissions: [{ key: 'settlements.view', allowedScopes: ['GLOBAL'] }],
        },
        { id: 'r-empty', key: 'empty', name: 'Empty', description: null, permissions: [] },
      ]),
    ),
    listRoleAssignments: vi.fn(() =>
      Promise.resolve([
        { roleId: 'r-picker', userId: 'u1', scopeType: 'WAREHOUSE', scopeId: W1 },
        { roleId: 'r-picker', userId: 'u2', scopeType: 'WAREHOUSE', scopeId: W2 },
        { roleId: 'r-picker', userId: 'u1', scopeType: 'WAREHOUSE', scopeId: W2 },
      ]),
    ),
    listActiveAssignments: vi.fn(() =>
      Promise.resolve([
        {
          userId: 'u1',
          assignment: {
            id: 'a1',
            roleId: 'r-picker',
            roleKey: 'picker',
            roleName: 'Picker',
            scopeType: 'WAREHOUSE',
            scopeId: W1,
            expiresAt: null,
          },
        },
      ]),
    ),
    createAssignment: vi.fn(),
  };
  const service = new AccessService({
    accessRepository,
    auditService: { record: vi.fn() },
    redis,
    logger: { warn: vi.fn() },
    runInTransaction: <T>(work: (t: Tx) => Promise<T>) => work(tx),
  } as unknown as ConstructorParameters<typeof AccessService>[0]);
  return { service, accessRepository, redis };
}

describe('scoped access (WAREHOUSE assignments)', () => {
  it('merges GLOBAL and one warehouse, never another warehouse', async () => {
    const t = accessSetup();
    const atW1 = await t.service.permissionsAt('u1', W1);
    const atW2 = await t.service.permissionsAt('u1', W2);
    expect([...atW1].sort()).toEqual(['dashboard.view', 'inventory.pick', 'warehouse.view']);
    expect([...atW2]).toEqual(['dashboard.view']);
  });

  it('reloads a cache entry written by an older build (no shape marker)', async () => {
    const t = accessSetup();
    await t.redis.set(
      authKeys.permissions('u1'),
      JSON.stringify({ v: '0', roles: [], permissions: ['x.y'], mfaRequired: false }),
    );
    const access = await t.service.getUserAccess('u1');
    expect(access.warehouses[W1]).toEqual(['inventory.pick', 'warehouse.view']);
    expect(t.accessRepository.loadUserAccess).toHaveBeenCalledTimes(1);
    await t.service.getUserAccess('u1');
    expect(t.accessRepository.loadUserAccess).toHaveBeenCalledTimes(1);
  });

  it('lists only warehouse role templates, with usage', async () => {
    const t = accessSetup();
    const templates = await t.service.listWarehouseRoleTemplates();
    expect(templates.map((r) => r.key)).toEqual(['picker']);
    expect(templates[0]?.usage).toEqual({ staffCount: 2, warehouseCount: 2 });
  });

  it('refuses a role that is not a warehouse template', async () => {
    const t = accessSetup();
    await expect(t.service.requireWarehouseRoleTemplate('r-finance')).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it('granting an assignment the user already holds is a no-op', async () => {
    const t = accessSetup();
    const result = await t.service.grantWarehouseRole(
      { userId: 'u1', roleId: 'r-picker', warehouseId: W1, actorUserId: 'm', reason: 'r' },
      tx,
    );
    expect(result.added).toBe(false);
    expect(t.accessRepository.createAssignment).not.toHaveBeenCalled();
  });
});

// ── StaffService: invite / resend / revoke ──────────────────────────────────────────────

function staffSetup(
  opts: {
    callerPermissions?: string[];
    existing?: LoginUserRecord | null;
    templatePermissions?: string[];
    members?: { userId: string; roles: { roleId: string }[] }[];
  } = {},
) {
  const accessService = {
    permissionsAt: vi.fn(() =>
      Promise.resolve(
        new Set(opts.callerPermissions ?? ['warehouse.team_manage', 'inventory.pick']),
      ),
    ),
    requireWarehouseRoleTemplate: vi.fn(() =>
      Promise.resolve({
        id: 'r-picker',
        key: 'picker',
        name: 'Picker',
        description: null,
        permissions: opts.templatePermissions ?? ['inventory.pick'],
        usage: { staffCount: 0, warehouseCount: 0 },
      }),
    ),
    grantWarehouseRole: vi.fn(() =>
      Promise.resolve({
        added: true,
        assignment: {
          id: 'a1',
          roleId: 'r-picker',
          roleKey: 'picker',
          roleName: 'Picker',
          scopeType: 'WAREHOUSE',
          scopeId: W1,
          expiresAt: null,
        },
      }),
    ),
    invalidateUser: vi.fn(() => Promise.resolve()),
    listScopeMembers: vi.fn(() =>
      Promise.resolve(opts.members ?? [{ userId: 'u-new', roles: [{ roleId: 'r-picker' }] }]),
    ),
    getRole: vi.fn(() => Promise.resolve({ permissions: ['inventory.pick'] })),
    revokeWarehouseRoles: vi.fn(() =>
      Promise.resolve([
        { id: 'a1', roleId: 'r-picker', roleKey: 'picker', scopeType: 'WAREHOUSE', scopeId: W1 },
      ]),
    ),
  };
  const usersService = {
    findLoginUser: vi.fn(() => Promise.resolve(opts.existing === undefined ? null : opts.existing)),
    findLoginUserById: vi.fn(() => Promise.resolve(pendingStaff)),
    createInvitedStaff: vi.fn(() => Promise.resolve(pendingStaff)),
  };
  const authService = { sendStaffInvitation: vi.fn(() => Promise.resolve(true)) };
  const sessionsService = {
    revokeAllForUser: vi.fn(() => Promise.resolve(['s1'])),
    publishRevocations: vi.fn(() => Promise.resolve(true)),
  };
  const auditService = { record: vi.fn(() => Promise.resolve()) };
  const service = new StaffService({
    accessService,
    usersService,
    authService,
    sessionsService,
    auditService,
    runInTransaction: <T>(work: (t: Tx) => Promise<T>) => work(tx),
  } as unknown as ConstructorParameters<typeof StaffService>[0]);
  return { service, accessService, usersService, authService, sessionsService, auditService };
}

const invite = {
  email: ' Priya@FarmX.in ',
  fullName: 'Priya Menon',
  roleId: 'r-picker',
  warehouseId: W1,
  invitedByUserId: 'u-manager',
};

describe('staff invitations', () => {
  it('creates a pending account, grants the role at the warehouse and emails a code', async () => {
    const t = staffSetup();
    const result = await t.service.invite(invite);
    expect(t.usersService.createInvitedStaff).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'priya@farmx.in' }),
      tx,
    );
    expect(t.accessService.grantWarehouseRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-new', roleId: 'r-picker', warehouseId: W1 }),
      tx,
    );
    expect(t.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.invited' }),
      tx,
    );
    expect(t.authService.sendStaffInvitation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ created: true, granted: true, invitationSent: true });
  });

  it('refuses a caller without warehouse.team_manage at that warehouse', async () => {
    const t = staffSetup({ callerPermissions: ['inventory.pick'] });
    await expect(t.service.invite(invite)).rejects.toBeInstanceOf(ForbiddenError);
    expect(t.usersService.createInvitedStaff).not.toHaveBeenCalled();
  });

  it('refuses a role granting more than the caller holds there (no escalation)', async () => {
    const t = staffSetup({ templatePermissions: ['inventory.pick', 'warehouse.status_change'] });
    await expect(t.service.invite(invite)).rejects.toMatchObject({
      details: { reason: 'PRIVILEGE_ESCALATION', permissions: ['warehouse.status_change'] },
    });
  });

  it('an existing ACTIVE staff account only gets the role (no code, no new account)', async () => {
    const t = staffSetup({ existing: { ...pendingStaff, id: 'u-old', status: 'ACTIVE' } });
    const result = await t.service.invite(invite);
    expect(t.usersService.createInvitedStaff).not.toHaveBeenCalled();
    expect(t.authService.sendStaffInvitation).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: false, granted: true, invitationSent: false });
  });

  it('a customer email cannot become a staff account (same message for any other kind)', async () => {
    const t = staffSetup({ existing: { ...pendingStaff, userType: 'CUSTOMER', status: 'ACTIVE' } });
    await expect(t.service.invite(invite)).rejects.toBeInstanceOf(ConflictError);
  });

  it('nobody removes their own access', async () => {
    const t = staffSetup();
    await expect(
      t.service.revoke({
        userId: 'u-manager',
        warehouseId: W1,
        revokedByUserId: 'u-manager',
        reason: 'leaving',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('removing a member ends their sessions and refreshes their access', async () => {
    const t = staffSetup();
    const result = await t.service.revoke({
      userId: 'u-new',
      warehouseId: W1,
      revokedByUserId: 'u-manager',
      reason: 'moved to another depot',
    });
    expect(result).toEqual({ revoked: 1 });
    expect(t.sessionsService.revokeAllForUser).toHaveBeenCalledWith('u-new', 'ROLE_CHANGED', tx);
    expect(t.accessService.invalidateUser).toHaveBeenCalledWith('u-new');
    expect(t.sessionsService.publishRevocations).toHaveBeenCalledWith(['s1']);
  });

  it('resending to someone who already accepted is a conflict', async () => {
    const t = staffSetup();
    t.usersService.findLoginUserById.mockResolvedValueOnce({ ...pendingStaff, status: 'ACTIVE' });
    await expect(
      t.service.resendInvitation({ userId: 'u-new', warehouseId: W1, requestedByUserId: 'm' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// ── AuthService: send + accept an invitation ────────────────────────────────────────────

function authSetup(user: LoginUserRecord | null, verify = 'ok') {
  const deps = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    authRepository: { recordEvent: vi.fn(() => Promise.resolve()) },
    otpService: {
      issue: vi.fn((_p: string, _d: string, deliver: (code: string) => Promise<void>) =>
        deliver('123456').then(() => ({ expiresIn: 172_800, resendAfter: 30 })),
      ),
      verify: vi.fn(() => Promise.resolve(verify)),
    },
    credentialsService: {
      hashNewPassword: vi.fn(() => Promise.resolve('argon-hash')),
      setInvitedPassword: vi.fn(() => Promise.resolve()),
    },
    usersService: {
      findLoginUser: vi.fn(() => Promise.resolve(user)),
      activateInvitedStaff: vi.fn(() => Promise.resolve()),
    },
    emailSender: { send: vi.fn(() => Promise.resolve()) },
    runInTransaction: <T>(work: (t: Tx) => Promise<T>) => work(tx),
  };
  const service = new AuthService(deps as unknown as ConstructorParameters<typeof AuthService>[0]);
  return { service, deps };
}

describe('accepting a warehouse invitation', () => {
  it('emails a 48 h code to the pending account', async () => {
    const t = authSetup(pendingStaff);
    expect(await t.service.sendStaffInvitation(pendingStaff)).toBe(true);
    expect(t.deps.otpService.issue).toHaveBeenCalledWith(
      'staff_invite',
      'u-new',
      expect.any(Function),
      48 * 3600,
    );
    expect(t.deps.emailSender.send).toHaveBeenCalledWith(
      'priya@farmx.in',
      expect.any(String),
      expect.stringContaining('123456'),
    );
  });

  it('a failed delivery keeps the account (returns false); a cooldown hit is a 429', async () => {
    const t = authSetup(pendingStaff);
    t.deps.otpService.issue.mockRejectedValueOnce(new Error('smtp down'));
    expect(await t.service.sendStaffInvitation(pendingStaff)).toBe(false);
    t.deps.otpService.issue.mockRejectedValueOnce(new RateLimitError(20));
    await expect(t.service.sendStaffInvitation(pendingStaff)).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('sets the first password and activates the account', async () => {
    const t = authSetup(pendingStaff);
    await t.service.acceptStaffInvitation('priya@farmx.in', '123456', 'Str0ng!Passw0rd', meta);
    expect(t.deps.credentialsService.setInvitedPassword).toHaveBeenCalledWith(
      'u-new',
      'argon-hash',
      tx,
    );
    expect(t.deps.usersService.activateInvitedStaff).toHaveBeenCalledWith('u-new', tx);
  });

  it('a wrong code is a generic 400 and changes nothing', async () => {
    const t = authSetup(pendingStaff, 'invalid');
    await expect(
      t.service.acceptStaffInvitation('priya@farmx.in', '000000', 'Str0ng!Passw0rd', meta),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(t.deps.credentialsService.setInvitedPassword).not.toHaveBeenCalled();
  });

  it('an account that is not a pending invitation gets the same 400 (no code check)', async () => {
    const t = authSetup({ ...pendingStaff, status: 'ACTIVE' });
    await expect(
      t.service.acceptStaffInvitation('priya@farmx.in', '123456', 'Str0ng!Passw0rd', meta),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(t.deps.otpService.verify).not.toHaveBeenCalled();
  });
});
