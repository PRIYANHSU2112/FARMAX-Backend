import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '@farmx/database';
import type { AuditActor, AuditEntry } from '../../src/features/audit/index.js';
import { UsersService } from '../../src/features/users/users.service.js';
import type { UserRecord } from '../../src/features/users/users.types.js';

const ADMIN_ID = '01900000-0000-7000-8000-000000000001';
const TARGET_ID = '01900000-0000-7000-8000-000000000002';
const OTHER_ADMIN_ID = '01900000-0000-7000-8000-000000000003';
const actor: AuditActor = {
  userId: ADMIN_ID,
  ip: '127.0.0.1',
  userAgent: 'test',
  requestId: 'req-1',
};

const makeUser = (overrides: Partial<UserRecord> = {}): UserRecord => ({
  id: TARGET_ID,
  userType: 'INTERNAL',
  email: 'ravi@farmx.in',
  emailVerifiedAt: new Date('2026-01-01'),
  phone: '+919876543210',
  phoneVerifiedAt: new Date('2026-01-01'),
  username: null,
  fullName: 'Ravi Kumar',
  displayName: null,
  avatarUrl: null,
  employeeCode: null,
  preferredLanguage: 'en',
  timezone: 'Asia/Kolkata',
  status: 'ACTIVE',
  statusReason: null,
  statusChangedAt: null,
  mfaRequired: true,
  mustChangePassword: false,
  lastLoginAt: null,
  createdByUserId: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
  ...overrides,
});

const assignment = {
  id: '01900000-0000-7000-8000-0000000000aa',
  roleId: '01900000-0000-7000-8000-0000000000bb',
  roleKey: 'warehouse_manager',
  roleName: 'Warehouse Manager',
  scopeType: 'GLOBAL' as const,
  scopeId: null,
  expiresAt: null,
};

interface SetupOptions {
  users?: UserRecord[];
  superAdmins?: string[];
  canAssignRoles?: boolean;
}

function setup(options: SetupOptions = {}) {
  const users = new Map((options.users ?? [makeUser()]).map((user) => [user.id, user]));
  const audit: AuditEntry[] = [];
  const tx = { marker: 'tx' } as unknown as Tx;

  const usersRepository = {
    findById: vi.fn((id: string) => Promise.resolve(users.get(id) ?? null)),
    list: vi.fn(),
    create: vi.fn((data: Partial<UserRecord>) => {
      const user = makeUser({ ...data, id: '01900000-0000-7000-8000-0000000000ff' });
      users.set(user.id, user);
      return Promise.resolve(user);
    }),
    update: vi.fn((id: string, data: Partial<UserRecord>) => {
      const user = { ...users.get(id)!, ...data };
      users.set(id, user);
      return Promise.resolve(user);
    }),
    countActive: vi.fn((ids: string[]) =>
      Promise.resolve(
        ids.filter((id) => users.get(id)?.status === 'ACTIVE' && users.get(id)?.deletedAt === null)
          .length,
      ),
    ),
  };
  const accessService = {
    hasPermission: vi.fn(() => Promise.resolve(options.canAssignRoles ?? true)),
    getRolesForUsers: vi.fn((ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, []])))),
    listActiveHolderIds: vi.fn(() => Promise.resolve(options.superAdmins ?? [ADMIN_ID])),
    lockRoleChanges: vi.fn(() => Promise.resolve()),
    setUserRoles: vi.fn(() =>
      Promise.resolve({ added: [assignment], removed: [], current: [assignment] }),
    ),
    invalidateUser: vi.fn(() => Promise.resolve()),
  };
  const credentialsService = {
    hashNewPassword: vi.fn(() => Promise.resolve('argon2-hash')),
    storeInitialPassword: vi.fn(() => Promise.resolve()),
  };
  const mfaService = { hasActiveTotp: vi.fn(() => Promise.resolve(false)) };
  const sessionsService = {
    revokeAllForUser: vi.fn(() => Promise.resolve(['s1', 's2'])),
    publishRevocations: vi.fn(() => Promise.resolve(true)),
  };
  const auditService = {
    record: vi.fn((entry: AuditEntry) => {
      audit.push(entry);
      return Promise.resolve();
    }),
  };
  const runInTransaction = vi.fn(<T>(work: (t: Tx) => Promise<T>) => work(tx));

  const service = new UsersService({
    usersRepository,
    accessService,
    credentialsService,
    mfaService,
    sessionsService,
    auditService,
    runInTransaction,
  } as unknown as ConstructorParameters<typeof UsersService>[0]);

  return {
    service,
    users,
    audit,
    tx,
    usersRepository,
    accessService,
    credentialsService,
    sessionsService,
    runInTransaction,
  };
}

describe('UsersService.create', () => {
  it('normalises identifiers, forces MFA for INTERNAL, stores the temporary password and audits', async () => {
    const t = setup({ users: [] });
    const view = await t.service.create(
      {
        userType: 'INTERNAL',
        email: '  Ravi@FarmX.in ',
        fullName: 'Ravi',
        mfaRequired: false,
        temporaryPassword: 'Str0ng-Passw0rd!',
      },
      actor,
    );

    expect(t.usersRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'ravi@farmx.in',
        mfaRequired: true,
        status: 'ACTIVE',
        mustChangePassword: true,
        createdByUserId: ADMIN_ID,
        registrationSource: 'admin',
      }),
      t.tx,
    );
    expect(t.credentialsService.storeInitialPassword).toHaveBeenCalledWith(
      view.id,
      'argon2-hash',
      t.tx,
    );
    expect(t.audit).toHaveLength(1);
    expect(t.audit[0]).toMatchObject({ action: 'user.created', targetId: view.id, actor });
    expect(JSON.stringify(t.audit[0])).not.toContain('argon2-hash');
    expect(JSON.stringify(t.audit[0])).not.toContain('Str0ng-Passw0rd!');
  });

  it('creates a PENDING_VERIFICATION user without credentials when no password is given', async () => {
    const t = setup({ users: [] });
    await t.service.create(
      { userType: 'CUSTOMER', phone: '+919876500000', fullName: 'Farmer' },
      actor,
    );
    expect(t.usersRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PENDING_VERIFICATION',
        mustChangePassword: false,
        mfaRequired: false,
      }),
      t.tx,
    );
    expect(t.credentialsService.storeInitialPassword).not.toHaveBeenCalled();
  });

  it('refuses an initial role without roles.assign and creates nothing', async () => {
    const t = setup({ users: [], canAssignRoles: false });
    await expect(
      t.service.create(
        {
          userType: 'INTERNAL',
          email: 'a@farmx.in',
          fullName: 'A',
          roles: [{ roleKey: 'warehouse_manager', scopeType: 'GLOBAL' }],
        },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(t.runInTransaction).not.toHaveBeenCalled();
  });

  it('assigns the initial role inside the same transaction', async () => {
    const t = setup({ users: [] });
    await t.service.create(
      {
        userType: 'INTERNAL',
        email: 'a@farmx.in',
        fullName: 'A',
        roles: [{ roleKey: 'warehouse_manager', scopeType: 'GLOBAL' }],
      },
      actor,
    );
    expect(t.accessService.setUserRoles).toHaveBeenCalledWith(
      expect.objectContaining({
        userType: 'INTERNAL',
        roles: [{ roleKey: 'warehouse_manager', scopeType: 'GLOBAL' }],
      }),
      t.tx,
    );
  });
});

describe('UsersService.update', () => {
  it('does nothing (no transaction, no audit) when nothing changes', async () => {
    const t = setup();
    await t.service.update(TARGET_ID, { fullName: 'Ravi Kumar' }, actor);
    expect(t.runInTransaction).not.toHaveBeenCalled();
  });

  it('audits only changed fields and resets verification of a changed email', async () => {
    const t = setup();
    await t.service.update(TARGET_ID, { email: 'NEW@farmx.in', fullName: 'Ravi Kumar' }, actor);
    expect(t.usersRepository.update).toHaveBeenCalledWith(
      TARGET_ID,
      { email: 'new@farmx.in', emailVerifiedAt: null },
      t.tx,
    );
    expect(t.audit[0]).toMatchObject({
      action: 'user.updated',
      before: { email: 'ravi@farmx.in' },
      after: { email: 'new@farmx.in' },
    });
  });

  it('refuses to disable MFA for INTERNAL users', async () => {
    const t = setup();
    await expect(t.service.update(TARGET_ID, { mfaRequired: false }, actor)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('returns 404 for a soft-deleted user', async () => {
    const t = setup({ users: [makeUser({ deletedAt: new Date() })] });
    await expect(t.service.update(TARGET_ID, { fullName: 'X' }, actor)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('UsersService.changeStatus', () => {
  it('forbids changing your own status', async () => {
    const t = setup({ users: [makeUser({ id: ADMIN_ID })] });
    await expect(
      t.service.changeStatus(ADMIN_ID, { status: 'SUSPENDED', reason: 'test' }, actor),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('suspends, revokes sessions in the transaction and publishes revocations after commit', async () => {
    const t = setup({ superAdmins: [ADMIN_ID] });
    const view = await t.service.changeStatus(
      TARGET_ID,
      { status: 'SUSPENDED', reason: 'policy breach' },
      actor,
    );

    expect(view.status).toBe('SUSPENDED');
    expect(t.accessService.lockRoleChanges).toHaveBeenCalledWith(t.tx);
    expect(t.sessionsService.revokeAllForUser).toHaveBeenCalledWith(
      TARGET_ID,
      'USER_SUSPENDED',
      t.tx,
    );
    expect(t.sessionsService.publishRevocations).toHaveBeenCalledWith(['s1', 's2']);
    expect(t.audit[0]).toMatchObject({
      action: 'user.status_changed',
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
      reason: 'policy breach',
    });
  });

  it('is a no-op when the status is unchanged', async () => {
    const t = setup();
    await t.service.changeStatus(TARGET_ID, { status: 'ACTIVE', reason: 'noop' }, actor);
    expect(t.runInTransaction).not.toHaveBeenCalled();
  });

  it('refuses to suspend the last active Super Admin', async () => {
    const t = setup({ superAdmins: [TARGET_ID] });
    await expect(
      t.service.changeStatus(TARGET_ID, { status: 'SUSPENDED', reason: 'x' }, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(t.usersRepository.update).not.toHaveBeenCalled();
  });

  it('allows suspending a Super Admin when another active one exists', async () => {
    const t = setup({
      users: [makeUser(), makeUser({ id: OTHER_ADMIN_ID })],
      superAdmins: [TARGET_ID, OTHER_ADMIN_ID],
    });
    await t.service.changeStatus(TARGET_ID, { status: 'SUSPENDED', reason: 'x' }, actor);
    expect(t.usersRepository.update).toHaveBeenCalled();
  });
});

describe('UsersService.setRoles', () => {
  const roles = [{ roleKey: 'warehouse_manager', scopeType: 'GLOBAL' as const }];

  it('forbids changing your own roles', async () => {
    const t = setup();
    await expect(t.service.setRoles(ADMIN_ID, { roles, reason: 'r' }, actor)).rejects.toMatchObject(
      {
        statusCode: 403,
      },
    );
  });

  it('refuses to remove the last Super Admin', async () => {
    const t = setup({ superAdmins: [TARGET_ID] });
    await expect(
      t.service.setRoles(TARGET_ID, { roles, reason: 'r' }, actor),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(t.accessService.setUserRoles).not.toHaveBeenCalled();
  });

  it('keeps super_admin without the last-admin check when it stays in the set', async () => {
    const t = setup({ superAdmins: [TARGET_ID] });
    await t.service.setRoles(
      TARGET_ID,
      { roles: [{ roleKey: 'super_admin', scopeType: 'GLOBAL' }], reason: 'r' },
      actor,
    );
    expect(t.accessService.setUserRoles).toHaveBeenCalled();
  });

  it('sets roles, revokes sessions (ROLE_CHANGED), audits and invalidates the access cache', async () => {
    const t = setup();
    const view = await t.service.setRoles(TARGET_ID, { roles, reason: 'promotion' }, actor);
    expect(t.accessService.setUserRoles).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TARGET_ID,
        roles,
        actorUserId: ADMIN_ID,
        reason: 'promotion',
      }),
      t.tx,
    );
    expect(t.sessionsService.revokeAllForUser).toHaveBeenCalledWith(
      TARGET_ID,
      'ROLE_CHANGED',
      t.tx,
    );
    expect(t.audit[0]).toMatchObject({ action: 'user_role.changed', subjectUserId: TARGET_ID });
    expect(t.accessService.invalidateUser).toHaveBeenCalledWith(TARGET_ID);
    expect(view.roles.map((r) => r.roleKey)).toEqual(['warehouse_manager']);
  });

  it('does not end sessions or audit when nothing changed', async () => {
    const t = setup();
    t.accessService.setUserRoles.mockResolvedValueOnce({
      added: [],
      removed: [],
      current: [assignment],
    });
    await t.service.setRoles(TARGET_ID, { roles, reason: 'noop' }, actor);
    expect(t.sessionsService.revokeAllForUser).not.toHaveBeenCalled();
    expect(t.audit).toHaveLength(0);
  });
});

describe('UsersService.block / unblock', () => {
  it('block suspends and ends sessions; unblock re-activates', async () => {
    const t = setup();
    const blocked = await t.service.block(TARGET_ID, 'shared credentials', actor);
    expect(blocked.status).toBe('SUSPENDED');
    expect(t.sessionsService.revokeAllForUser).toHaveBeenCalledWith(
      TARGET_ID,
      'USER_SUSPENDED',
      t.tx,
    );
    const active = await t.service.unblock(TARGET_ID, 'resolved', actor);
    expect(active.status).toBe('ACTIVE');
  });
});

describe('UsersService.softDelete / forceLogout', () => {
  it('soft-deletes: deletedAt + DEACTIVATED, sessions revoked, audited', async () => {
    const t = setup();
    await t.service.softDelete(TARGET_ID, 'left the company', actor);
    expect(t.users.get(TARGET_ID)).toMatchObject({ status: 'DEACTIVATED' });
    expect(t.users.get(TARGET_ID)?.deletedAt).toBeInstanceOf(Date);
    expect(t.sessionsService.revokeAllForUser).toHaveBeenCalledWith(
      TARGET_ID,
      'USER_SUSPENDED',
      t.tx,
    );
    expect(t.audit[0]).toMatchObject({ action: 'user.deleted', reason: 'left the company' });
  });

  it('forbids deleting yourself', async () => {
    const t = setup();
    await expect(t.service.softDelete(ADMIN_ID, 'x', actor)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('force-logout revokes all sessions and reports whether access tokens were blocked', async () => {
    const t = setup();
    t.sessionsService.publishRevocations.mockResolvedValueOnce(false);
    const result = await t.service.forceLogout(TARGET_ID, 'lost phone', actor);
    expect(result).toEqual({ revokedSessions: 2, accessTokensBlocked: false });
    expect(t.sessionsService.revokeAllForUser).toHaveBeenCalledWith(TARGET_ID, 'ADMIN', t.tx);
    expect(t.audit[0]).toMatchObject({
      action: 'session.force_logout',
      metadata: { revokedSessions: 2 },
    });
  });
});
