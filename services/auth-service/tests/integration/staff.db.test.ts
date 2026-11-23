import { randomInt, randomUUID } from 'node:crypto';

import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

/**
 * Warehouse staff invitations + WAREHOUSE-scoped access (D-56) against REAL Postgres + Redis:
 *   AUTH_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/auth-service test
 * Skipped when the variable is not set. Uses the dev OTP code (console email/SMS).
 */
const DB_URL = process.env.AUTH_IT_DATABASE_URL;
const CODE = '123456';
const TOKEN = 'internal-token-for-tests-0123456789abcdef';
const internal = { [INTERNAL_TOKEN_HEADER]: TOKEN };

describe.skipIf(DB_URL === undefined)('warehouse staff invitations (Postgres + Redis)', () => {
  let app: FastifyInstance;
  const run = String(randomInt(100_000, 999_999));
  const warehouseId = randomUUID();
  const otherWarehouseId = randomUUID();
  const email = `picker.${run}@farmx-it.in`;
  const ids = { manager: '', pickerRole: '', receiverRole: '' };

  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers });

  beforeAll(async () => {
    app = await buildApp({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: DB_URL,
      REDIS_CACHE_URL: 'redis://localhost:6379/11',
      SMS_PROVIDER: 'console',
      OTP_DEV_CODE: CODE,
      INTERNAL_SERVICE_TOKEN: TOKEN,
    });
    await app.ready();
    const db = app.diContainer.resolve('db');

    // The fixed catalog keys these roles use (`pnpm db:seed` syncs them; upsert = seed-free test).
    const scopes = ['GLOBAL', 'REGION', 'WAREHOUSE'] as const;
    const perm = async (key: string) => {
      const [module = '', action = ''] = key.split('.');
      return db.permission.upsert({
        where: { key },
        create: { key, module, action, description: key, allowedScopes: [...scopes] },
        update: {},
        select: { id: true },
      });
    };
    const [teamManage, pick, view, receive] = await Promise.all([
      perm('warehouse.team_manage'),
      perm('inventory.pick'),
      perm('warehouse.view'),
      perm('inventory.receive'),
    ]);
    const role = (key: string, permissionIds: string[]) =>
      db.role.create({
        data: {
          key: `${key}_${run}`,
          name: `${key} ${run}`,
          audience: 'INTERNAL',
          mfaRequired: false,
          permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
        },
        select: { id: true },
      });
    const managerRole = await role('it_wh_manager', [teamManage.id, pick.id, view.id]);
    ids.pickerRole = (await role('it_picker', [pick.id])).id;
    ids.receiverRole = (await role('it_receiver', [receive.id])).id;

    const manager = await db.user.create({
      data: {
        userType: 'INTERNAL',
        email: `manager.${run}@farmx-it.in`,
        fullName: 'Ravi Kumar',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    ids.manager = manager.id;
    await db.userRole.create({
      data: {
        userId: manager.id,
        roleId: managerRole.id,
        scopeType: 'WAREHOUSE',
        scopeId: warehouseId,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('a WAREHOUSE-scoped role grants at that warehouse only (never globally)', async () => {
    const access = await app.diContainer.resolve('accessService').getUserAccess(ids.manager);
    expect(access.permissions).toEqual([]);
    expect(access.warehouses[warehouseId]).toEqual([
      'inventory.pick',
      'warehouse.team_manage',
      'warehouse.view',
    ]);
    expect(access.warehouses[otherWarehouseId]).toBeUndefined();

    const res = await app.inject({
      method: 'GET',
      url: `/internal/access/${ids.manager}/permissions`,
      headers: internal,
    });
    expect(res.json<{ data: { warehouses: Record<string, string[]> } }>().data.warehouses).toEqual(
      access.warehouses,
    );
  });

  it('refuses a role that grants more than the manager holds there (no escalation)', async () => {
    const res = await post(
      '/internal/staff/invitations',
      {
        email,
        fullName: 'Priya Menon',
        roleId: ids.receiverRole,
        warehouseId,
        invitedByUserId: ids.manager,
      },
      internal,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'PRIVILEGE_ESCALATION',
    );
  });

  it('refuses a manager acting on another warehouse', async () => {
    const res = await post(
      '/internal/staff/invitations',
      {
        email,
        fullName: 'Priya Menon',
        roleId: ids.pickerRole,
        warehouseId: otherWarehouseId,
        invitedByUserId: ids.manager,
      },
      internal,
    );
    expect(res.statusCode).toBe(403);
  });

  it('invite → member listed → accept with the emailed code → sign in → remove', async () => {
    const invited = await post(
      '/internal/staff/invitations',
      {
        email,
        fullName: 'Priya Menon',
        roleId: ids.pickerRole,
        warehouseId,
        invitedByUserId: ids.manager,
      },
      internal,
    );
    expect(invited.statusCode, invited.body).toBe(201);
    const result = invited.json<{ data: { userId: string } }>().data;
    expect(result).toMatchObject({ created: true, granted: true, invitationSent: true });

    // Inviting again is idempotent: same account, nothing new granted.
    const again = await post(
      '/internal/staff/invitations',
      {
        email,
        fullName: 'Priya Menon',
        roleId: ids.pickerRole,
        warehouseId,
        invitedByUserId: ids.manager,
      },
      internal,
    );
    expect(again.json<{ data: object }>().data).toMatchObject({
      userId: result.userId,
      created: false,
      granted: false,
    });

    const members = await app.inject({
      method: 'GET',
      url: `/internal/access/scope-members?scopeType=WAREHOUSE&scopeId=${warehouseId}`,
      headers: internal,
    });
    const listed = members
      .json<{ data: { members: { userId: string }[] } }>()
      .data.members.map((m) => m.userId);
    expect(listed).toEqual(expect.arrayContaining([ids.manager, result.userId]));

    // Pending accounts cannot sign in yet.
    const early = await post('/auth/admin/login', { identifier: email, password: 'x'.repeat(12) });
    expect(early.statusCode).toBe(401);

    const wrong = await post('/auth/invitations/accept', {
      email,
      code: '000000',
      newPassword: 'Warehouse#2026Safe',
    });
    expect(wrong.statusCode).toBe(400);

    // A wrong guess spent an attempt but the code is still valid (5 attempts).
    const accepted = await post('/auth/invitations/accept', {
      email,
      code: CODE,
      newPassword: 'Warehouse#2026Safe',
    });
    expect(accepted.statusCode, accepted.body).toBe(204);

    const login = await post('/auth/admin/login', {
      identifier: email,
      password: 'Warehouse#2026Safe',
    });
    expect(login.statusCode, login.body).toBe(200);

    const removed = await post(
      '/internal/staff/assignments/revoke',
      {
        userId: result.userId,
        warehouseId,
        revokedByUserId: ids.manager,
        reason: 'moved to another depot',
      },
      internal,
    );
    expect(removed.json<{ data: object }>().data).toEqual({ revoked: 1 });
    const access = await app.diContainer.resolve('accessService').getUserAccess(result.userId);
    expect(access.warehouses[warehouseId]).toBeUndefined();
  });
});
