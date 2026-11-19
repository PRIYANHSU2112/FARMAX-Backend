import { createLogger } from '@farmx/common/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, getDatabase } from '../client.js';

// No query is sent: the pg pool connects lazily, so these tests need no running database.
const logger = createLogger({ service: 'database-test', level: 'silent' });
const url = 'postgresql://test:test@localhost:5432/farmx_test';

afterEach(async () => {
  await closeDatabase();
});

describe('getDatabase (singleton pool)', () => {
  it('returns the same client for every call in a process', () => {
    expect(getDatabase({ url, logger })).toBe(getDatabase({ url, logger }));
  });

  it('refuses a second, different DATABASE_URL', () => {
    getDatabase({ url, logger });
    expect(() => getDatabase({ url: `${url}_other`, logger })).toThrow(/different DATABASE_URL/);
  });

  it('creates a fresh client after closeDatabase()', async () => {
    const first = getDatabase({ url, logger });
    await closeDatabase();
    expect(getDatabase({ url, logger })).not.toBe(first);
  });
});
