import type { Tx } from '@farmx/database';
import { describe, expect, it, vi } from 'vitest';

import { SessionsService } from '../../src/features/sessions/sessions.service.js';
import type { SessionLockRow } from '../../src/features/sessions/sessions.types.js';
import { FakeRedis } from '../helpers/fake-redis.js';

const now = Date.now();
const row = (overrides: Partial<SessionLockRow> = {}): SessionLockRow => ({
  id: 'old',
  userId: 'u1',
  familyId: 'f1',
  deviceId: null,
  rotatedAt: null,
  revokedAt: null,
  lastUsedAt: new Date(now - 60_000),
  idleExpiresAt: new Date(now + 30 * 60_000 - 60_000),
  absoluteExpiresAt: new Date(now + 12 * 3_600_000),
  mfaVerifiedAt: null,
  ...overrides,
});

function setup(locked: SessionLockRow | null) {
  const redis = new FakeRedis();
  const tx = {} as Tx;
  const sessionsRepository = {
    lockByTokenHash: vi.fn(() => Promise.resolve(locked)),
    create: vi.fn(() => Promise.resolve({ id: 'new' })),
    markRotated: vi.fn(() => Promise.resolve()),
    revokeFamily: vi.fn(() => Promise.resolve(['old', 'sibling'])),
    revoke: vi.fn(() => Promise.resolve(true)),
  };
  const service = new SessionsService({
    sessionsRepository,
    redis,
    logger: { error: vi.fn() },
    runInTransaction: <T>(work: (t: Tx) => Promise<T>) => work(tx),
  } as unknown as ConstructorParameters<typeof SessionsService>[0]);
  return { service, sessionsRepository, redis, tx };
}

describe('refresh-token rotation', () => {
  it('rotates: new row in the same family, old marked rotated, old sid blocked', async () => {
    const t = setup(row());
    const result = await t.service.rotate('token', { ip: '1.1.1.1' });
    expect(result).toMatchObject({ ok: true, userId: 'u1', sessionId: 'new' });
    expect(result.ok && result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.sessionsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'f1',
        userId: 'u1',
        absoluteExpiresAt: row().absoluteExpiresAt,
      }),
      t.tx,
    );
    expect(t.sessionsRepository.markRotated).toHaveBeenCalledWith(
      'old',
      'new',
      expect.any(Date),
      t.tx,
    );
    expect(await t.redis.get('farmx:auth:v1:revoked:sid:old')).toBe('1');
  });

  it('keeps the idle window size and never passes the absolute cap', async () => {
    const t = setup(row({ absoluteExpiresAt: new Date(now + 5 * 60_000) }));
    await t.service.rotate('token', {});
    const created = t.sessionsRepository.create.mock.calls[0] as unknown as [
      { idleExpiresAt: Date },
    ];
    expect(created[0].idleExpiresAt.getTime()).toBeLessThanOrEqual(now + 5 * 60_000);
  });

  it('unknown token → refused', async () => {
    await expect(setup(null).service.rotate('nope', {})).resolves.toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('revoked session → refused', async () => {
    const t = setup(row({ revokedAt: new Date() }));
    await expect(t.service.rotate('token', {})).resolves.toMatchObject({
      ok: false,
      reason: 'revoked',
    });
  });

  it('rotated token within the grace window → refused WITHOUT revoking the family', async () => {
    const t = setup(row({ rotatedAt: new Date(Date.now() - 2_000) }));
    await expect(t.service.rotate('token', {})).resolves.toMatchObject({
      ok: false,
      reason: 'rotated_recently',
    });
    expect(t.sessionsRepository.revokeFamily).not.toHaveBeenCalled();
  });

  it('REUSE after the grace window → whole family revoked and blocked', async () => {
    const t = setup(row({ rotatedAt: new Date(Date.now() - 60_000) }));
    await expect(t.service.rotate('token', {})).resolves.toMatchObject({
      ok: false,
      reason: 'reused',
      userId: 'u1',
    });
    expect(t.sessionsRepository.revokeFamily).toHaveBeenCalledWith(
      'f1',
      'REUSE_DETECTED',
      expect.any(Date),
      t.tx,
    );
    expect(await t.redis.get('farmx:auth:v1:revoked:sid:sibling')).toBe('1');
  });

  it('idle-expired session → revoked (IDLE_TIMEOUT) and refused', async () => {
    const t = setup(row({ idleExpiresAt: new Date(Date.now() - 1_000) }));
    await expect(t.service.rotate('token', {})).resolves.toMatchObject({
      ok: false,
      reason: 'expired',
    });
    expect(t.sessionsRepository.revoke).toHaveBeenCalledWith(
      'old',
      'IDLE_TIMEOUT',
      expect.any(Date),
      undefined,
      t.tx,
    );
  });
});

describe('logout blacklist', () => {
  it('blacklists the jti until the token would expire', async () => {
    const t = setup(null);
    await t.service.blacklistAccessToken('jti-1', Math.floor(Date.now() / 1000) + 600);
    expect(await t.redis.get('farmx:auth:v1:revoked:jti:jti-1')).toBe('1');
    expect(await t.redis.ttl('farmx:auth:v1:revoked:jti:jti-1')).toBeGreaterThan(590);
  });

  it('skips already-expired tokens', async () => {
    const t = setup(null);
    await t.service.blacklistAccessToken('jti-2', Math.floor(Date.now() / 1000) - 1);
    expect(await t.redis.get('farmx:auth:v1:revoked:jti:jti-2')).toBeNull();
  });
});
