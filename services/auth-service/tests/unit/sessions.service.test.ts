import { describe, expect, it, vi } from 'vitest';

import { SessionsService } from '../../src/features/sessions/sessions.service.js';

function setup(execImpl: () => Promise<unknown>) {
  const set = vi.fn();
  const multi = vi.fn(() => ({ set, exec: execImpl }));
  const logger = { error: vi.fn() };
  const sessionsRepository = { revokeAllForUser: vi.fn(() => Promise.resolve(['s1'])) };
  const service = new SessionsService({
    sessionsRepository,
    redis: { multi },
    logger,
  } as unknown as ConstructorParameters<typeof SessionsService>[0]);
  return { service, set, multi, logger, sessionsRepository };
}

describe('SessionsService.publishRevocations', () => {
  it('writes one revoked-sid flag per session with the access-token TTL', async () => {
    const t = setup(() => Promise.resolve([]));
    await expect(t.service.publishRevocations(['s1', 's2'])).resolves.toBe(true);
    expect(t.set).toHaveBeenCalledWith('farmx:auth:v1:revoked:sid:s1', '1', 'EX', 900);
    expect(t.set).toHaveBeenCalledWith('farmx:auth:v1:revoked:sid:s2', '1', 'EX', 900);
  });

  it('skips Redis when there is nothing to revoke', async () => {
    const t = setup(() => Promise.resolve([]));
    await expect(t.service.publishRevocations([])).resolves.toBe(true);
    expect(t.multi).not.toHaveBeenCalled();
  });

  it('never throws when Redis is down (DB revocation already committed)', async () => {
    const t = setup(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(t.service.publishRevocations(['s1'])).resolves.toBe(false);
    expect(t.logger.error).toHaveBeenCalled();
  });
});
