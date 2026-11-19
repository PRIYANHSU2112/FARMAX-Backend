import { describe, expect, it, vi } from 'vitest';

import { hitRateLimit } from '../rate-limit.js';

describe('hitRateLimit', () => {
  it('allows up to the limit, then refuses with retry-after from the TTL', async () => {
    const counts = [1, 5, 6];
    const client = { eval: vi.fn(() => Promise.resolve([counts.shift(), 42])) };
    await expect(hitRateLimit(client, 'k', 5, 60)).resolves.toMatchObject({
      allowed: true,
      remaining: 4,
    });
    await expect(hitRateLimit(client, 'k', 5, 60)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(hitRateLimit(client, 'k', 5, 60)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 42,
    });
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining('INCR'), 1, 'k', 60);
  });

  it('rejects invalid limits', async () => {
    const client = { eval: vi.fn() };
    await expect(hitRateLimit(client, 'k', 0, 60)).rejects.toThrow(/limit/);
    await expect(hitRateLimit(client, 'k', 5, 1.5)).rejects.toThrow(/windowSeconds/);
  });
});
