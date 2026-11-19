import { describe, expect, it } from 'vitest';

import { requirePermission } from '../../src/features/access/access.guard.js';

describe('requirePermission', () => {
  it('throws at definition time for a key that is not in the fixed catalog', () => {
    expect(() => requirePermission('users.veiw')).toThrow(/unknown permission/);
  });

  it('accepts catalog keys', () => {
    expect(typeof requirePermission('users.view')).toBe('function');
  });
});
