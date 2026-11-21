import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';

const base = { DATABASE_URL: 'postgresql://farmx:farmx@localhost:5432/farmx' };
const prod = { ...base, APP_ENV: 'prod', JWT_PUBLIC_KEY: 'AAAA' };

describe('call-service config: telephony fails closed in production', () => {
  it('defaults to mock outside production', () => {
    expect(loadConfig({ ...base, APP_ENV: 'local' }).TELEPHONY_PROVIDER).toBe('mock');
  });

  it('refuses to boot in production when TELEPHONY_PROVIDER is unset (no silent mock default)', () => {
    expect(() => loadConfig(prod)).toThrow(/TELEPHONY_PROVIDER is required/);
  });

  it('refuses TELEPHONY_PROVIDER=mock in production', () => {
    expect(() => loadConfig({ ...prod, TELEPHONY_PROVIDER: 'mock' })).toThrow(/not allowed/);
  });
});
