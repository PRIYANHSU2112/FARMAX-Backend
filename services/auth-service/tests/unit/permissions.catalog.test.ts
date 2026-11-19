import { describe, expect, it } from 'vitest';

import {
  PERMISSION_CATALOG,
  PERMISSIONS,
  PERMISSION_KEYS,
} from '../../src/features/access/permissions.catalog.js';

const KEY_FORMAT = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

describe('permission catalog (fixed permissions)', () => {
  it('has unique keys', () => {
    expect(PERMISSION_KEYS.size).toBe(PERMISSIONS.length);
  });

  it('uses <module>.<action> lower snake_case keys', () => {
    for (const permission of PERMISSIONS) expect(permission.key).toMatch(KEY_FORMAT);
  });

  it('has unique module groups and a description on every key', () => {
    const modules = PERMISSION_CATALOG.map((group) => group.module);
    expect(new Set(modules).size).toBe(modules.length);
    for (const permission of PERMISSIONS) expect(permission.description.length).toBeGreaterThan(0);
  });

  it('gives every permission at least one allowed scope', () => {
    for (const permission of PERMISSIONS)
      expect(permission.allowedScopes.length).toBeGreaterThan(0);
  });

  it('marks every non-assignable permission as sensitive and GLOBAL-only', () => {
    for (const permission of PERMISSIONS.filter((p) => !p.assignable)) {
      expect(permission.isSensitive, permission.key).toBe(true);
      expect(permission.allowedScopes, permission.key).toEqual(['GLOBAL']);
    }
  });

  // PRD P8 / BL-03 / BL-16 / §17: Super Administrator is the sole authority for these.
  it.each([
    'inventory.adjust',
    'inventory.quarantine_release',
    'pricing.override',
    'settlements.reverse',
    'roles.create',
    'roles.update',
    'roles.assign',
  ])('reserves %s for super_admin', (key) => {
    const permission = PERMISSIONS.find((p) => p.key === key);
    expect(permission?.assignable).toBe(false);
  });

  it('keeps sort order unique and stable', () => {
    const orders = PERMISSIONS.map((p) => p.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });
});
