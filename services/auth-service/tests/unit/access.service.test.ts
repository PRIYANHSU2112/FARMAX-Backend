import type { Tx } from '@farmx/database';
import { describe, expect, it, vi } from 'vitest';

import { AccessService } from '../../src/features/access/access.service.js';
import type { RoleAssignment, RoleView } from '../../src/features/access/access.types.js';
import { FakeRedis } from '../helpers/fake-redis.js';

const tx = {} as Tx;
const actor = { userId: 'admin', ip: null, userAgent: null, requestId: 'r' };
const access = {
  roles: ['warehouse_manager'],
  permissions: ['inventory.view'],
  mfaRequired: true,
  sessionIdleMinutes: 30,
};

const assignment = (over: Partial<RoleAssignment> = {}): RoleAssignment => ({
  id: 'a1',
  roleId: 'r-wm',
  roleKey: 'warehouse_manager',
  roleName: 'Warehouse Manager',
  scopeType: 'GLOBAL',
  scopeId: null,
  expiresAt: null,
  ...over,
});

const role = (over: Partial<RoleView> = {}): RoleView => ({
  id: 'r1',
  key: 'support',
  name: 'Support',
  description: null,
  audience: 'INTERNAL',
  isSystem: false,
  mfaRequired: true,
  sessionIdleMinutes: null,
  permissions: [],
  activeHolders: 0,
  createdAt: '',
  updatedAt: '',
  archivedAt: null,
  ...over,
});

function setup() {
  const redis = new FakeRedis();
  const accessRepository = {
    loadUserAccess: vi.fn(() => Promise.resolve(access)),
    findActiveRolesByKeys: vi.fn((keys: string[]) =>
      Promise.resolve(
        keys
          .filter((k) => ['warehouse_manager', 'support', 'vendor_admin'].includes(k))
          .map((k) => ({
            id: `r-${k === 'warehouse_manager' ? 'wm' : k}`,
            key: k,
            audience: k === 'vendor_admin' ? 'VENDOR' : 'INTERNAL',
            isSystem: false,
            archivedAt: null,
          })),
      ),
    ),
    listActiveAssignments: vi.fn(() =>
      Promise.resolve([{ userId: 'u1', assignment: assignment() }]),
    ),
    revokeAssignments: vi.fn(() => Promise.resolve()),
    createAssignment: vi.fn(
      (data: { roleId: string; scopeType: 'GLOBAL' | 'WAREHOUSE'; scopeId: string | null }) =>
        Promise.resolve(
          assignment({
            id: 'a2',
            roleId: data.roleId,
            roleKey: 'support',
            scopeType: data.scopeType,
            scopeId: data.scopeId,
          }),
        ),
    ),
    findPermissionsByKeys: vi.fn((keys: string[]) =>
      Promise.resolve(
        keys
          .filter((k) => k !== 'nope.nope')
          .map((k) => ({
            id: `p-${k}`,
            key: k,
            assignable: k !== 'roles.assign',
            deprecatedAt: null,
          })),
      ),
    ),
    findRoleView: vi.fn(() => Promise.resolve(role())),
    createRole: vi.fn(() => Promise.resolve({ id: 'r1' })),
    replaceRolePermissions: vi.fn(() => Promise.resolve()),
    updateRole: vi.fn(() => Promise.resolve()),
  };
  const auditService = { record: vi.fn(() => Promise.resolve()) };
  const service = new AccessService({
    accessRepository,
    auditService,
    redis,
    logger: { warn: vi.fn() },
    runInTransaction: <T>(work: (t: Tx) => Promise<T>) => work(tx),
  } as unknown as ConstructorParameters<typeof AccessService>[0]);
  return { service, accessRepository, auditService, redis };
}

describe('permission resolution (Redis cache)', () => {
  it('hits the DB once, then serves from cache', async () => {
    const t = setup();
    expect(await t.service.hasPermission('u1', 'inventory.view')).toBe(true);
    expect(await t.service.hasPermission('u1', 'users.view')).toBe(false);
    expect(t.accessRepository.loadUserAccess).toHaveBeenCalledTimes(1);
  });

  it('a role change (version bump) invalidates every cached entry', async () => {
    const t = setup();
    await t.service.getUserAccess('u1');
    await t.service.setRolePermissions(
      'r1',
      { permissions: ['inventory.view'], reason: 'tighten' },
      actor,
    );
    await t.service.getUserAccess('u1');
    expect(t.accessRepository.loadUserAccess).toHaveBeenCalledTimes(2);
  });

  it('invalidateUser drops one user', async () => {
    const t = setup();
    await t.service.getUserAccess('u1');
    await t.service.invalidateUser('u1');
    await t.service.getUserAccess('u1');
    expect(t.accessRepository.loadUserAccess).toHaveBeenCalledTimes(2);
  });

  it('falls back to the DB when Redis fails', async () => {
    const t = setup();
    t.redis.mget = () => Promise.reject(new Error('down'));
    expect(await t.service.hasPermission('u1', 'inventory.view')).toBe(true);
  });
});

describe('setUserRoles (diff)', () => {
  it('keeps unchanged, revokes removed, adds new', async () => {
    const t = setup();
    const result = await t.service.setUserRoles(
      {
        userId: 'u1',
        userType: 'INTERNAL',
        roles: [{ roleKey: 'support', scopeType: 'GLOBAL' }],
        actorUserId: 'admin',
        reason: 'move',
      },
      tx,
    );
    expect(t.accessRepository.revokeAssignments).toHaveBeenCalledWith(
      ['a1'],
      'admin',
      'move',
      expect.any(Date),
      tx,
    );
    expect(result.added).toHaveLength(1);
    expect(result.removed.map((a) => a.id)).toEqual(['a1']);
  });

  it('no-op when the set is unchanged', async () => {
    const t = setup();
    const result = await t.service.setUserRoles(
      {
        userId: 'u1',
        userType: 'INTERNAL',
        roles: [{ roleKey: 'warehouse_manager', scopeType: 'GLOBAL' }],
        actorUserId: 'admin',
        reason: 'same',
      },
      tx,
    );
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(t.accessRepository.createAssignment).not.toHaveBeenCalled();
  });

  it('refuses unknown roles (404), audience mismatch and bad scopes (400)', async () => {
    const t = setup();
    const base = { userId: 'u1', userType: 'INTERNAL' as const, actorUserId: 'admin', reason: 'x' };
    await expect(
      t.service.setUserRoles({ ...base, roles: [{ roleKey: 'ghost', scopeType: 'GLOBAL' }] }, tx),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      t.service.setUserRoles(
        { ...base, roles: [{ roleKey: 'vendor_admin', scopeType: 'GLOBAL' }] },
        tx,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      t.service.setUserRoles(
        { ...base, roles: [{ roleKey: 'support', scopeType: 'WAREHOUSE' }] },
        tx,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('roles', () => {
  it('refuses Super-Admin-only and unknown permissions', async () => {
    const t = setup();
    await expect(
      t.service.createRole(
        { key: 'r', name: 'R', audience: 'INTERNAL', permissions: ['roles.assign'] },
        actor,
      ),
    ).rejects.toThrow(/Reserved for Super Admin/);
    await expect(
      t.service.createRole(
        { key: 'r', name: 'R', audience: 'INTERNAL', permissions: ['nope.nope'] },
        actor,
      ),
    ).rejects.toThrow(/Unknown or deprecated/);
  });

  it('creates with permissions and audits in the same transaction', async () => {
    const t = setup();
    await t.service.createRole(
      { key: 'support', name: 'Support', audience: 'INTERNAL', permissions: ['support.view'] },
      actor,
    );
    expect(t.accessRepository.createRole).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'support' }),
      ['p-support.view'],
      tx,
    );
    expect(t.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'role.created' }),
      tx,
    );
  });

  it('system roles cannot be changed (409)', async () => {
    const t = setup();
    t.accessRepository.findRoleView.mockResolvedValueOnce(
      role({ isSystem: true, key: 'super_admin' }),
    );
    await expect(t.service.updateRole('r1', { name: 'x' }, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('lists the fixed catalog grouped by module', () => {
    const groups = setup().service.listPermissions();
    expect(groups.find((g) => g.module === 'users')?.permissions.map((p) => p.key)).toContain(
      'users.view',
    );
  });
});
