import { ServiceUnavailableError } from '@farmx/common/errors';
import { createLogger } from '@farmx/common/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthDirectory } from '../../src/adapters/auth-directory.js';
import { loadConfig } from '../../src/config/index.js';

const TOKEN = 'internal-token-for-tests-0123456789abcdef';
const logger = createLogger({ service: 'test', level: 'silent', appEnv: 'local', version: '0' });
const config = (token?: string) =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://t:t@localhost:5432/t',
    ...(token === undefined ? {} : { INTERNAL_SERVICE_TOKEN: token }),
  });
const json = (status: number, data: unknown) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthDirectory', () => {
  it('sends the internal token and returns the contact', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(200, { id: 'u1', phone: '+91900' })));
    vi.stubGlobal('fetch', fetchMock);
    const dir = new AuthDirectory({ config: config(TOKEN), logger });
    await expect(dir.getContact('u1')).resolves.toMatchObject({ id: 'u1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/internal/users/u1/contact');
    expect((init.headers as Record<string, string>)['x-internal-token']).toBe(TOKEN);
  });

  it('404 contact → null; 5xx and network errors → retryable ServiceUnavailableError', async () => {
    const dir = new AuthDirectory({ config: config(TOKEN), logger });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(404, null))),
    );
    await expect(dir.getContact('u1')).resolves.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(503, null))),
    );
    await expect(dir.listPermissionHolders('orders.confirm')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    await expect(dir.listActiveIds('CUSTOMER', null, 500)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it('a 404 on an audience lookup is an error, never "no recipients"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(404, null))),
    );
    const dir = new AuthDirectory({ config: config(TOKEN), logger });
    await expect(dir.listPermissionHolders('orders.confirm')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it('builds audience queries (warehouse scope, keyset cursor)', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(() =>
      Promise.resolve(json(200, { userIds: ['a'] })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const dir = new AuthDirectory({ config: config(TOKEN), logger });
    await expect(dir.listPermissionHolders('inventory.view', 'w1')).resolves.toEqual(['a']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:3001/internal/access/recipients?permission=inventory.view&warehouseId=w1',
    );
    fetchMock.mockImplementation(() => Promise.resolve(json(200, { ids: ['b'], nextCursor: 'b' })));
    await dir.listActiveIds('CUSTOMER', 'a', 2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://localhost:3001/internal/users/ids?userType=CUSTOMER&limit=2&cursor=a',
    );
  });

  it('without INTERNAL_SERVICE_TOKEN every lookup fails (retryable), nothing is sent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const dir = new AuthDirectory({ config: config(), logger });
    await expect(dir.getContact('u1')).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('config', () => {
  it('requires INTERNAL_SERVICE_TOKEN in prod', () => {
    expect(() =>
      loadConfig({
        APP_ENV: 'prod',
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://t:t@localhost:5432/t',
        JWT_PUBLIC_KEY: Buffer.from('key').toString('base64'),
      }),
    ).toThrow(/INTERNAL_SERVICE_TOKEN/);
  });
});
