import { ForbiddenError, NotFoundError } from '@farmx/common/errors';
import { describe, expect, it } from 'vitest';

import { Access } from '../../src/middleware/access.js';

const W1 = 'w-1';
const W2 = 'w-2';

describe('warehouse-scoped access', () => {
  const manager = new Access({
    permissions: ['dashboard.view'],
    warehouses: { [W1]: ['warehouse.view', 'warehouse.configure'], [W2]: ['warehouse.view'] },
  });
  const central = new Access({
    permissions: ['warehouse.view', 'warehouse.create'],
    warehouses: {},
  });

  it('grants a scoped key at its warehouse only', () => {
    expect(manager.can('warehouse.configure', W1)).toBe(true);
    expect(manager.can('warehouse.configure', W2)).toBe(false);
    expect(manager.isGlobal('warehouse.configure')).toBe(false);
  });

  it('lists where a key applies', () => {
    expect(manager.scope('warehouse.view')).toEqual([W1, W2]);
    expect(manager.scope('warehouse.configure')).toEqual([W1]);
    expect(central.scope('warehouse.view')).toBe('ALL');
  });

  it('404 for an invisible warehouse, 403 for a visible one without the key', () => {
    expect(() => {
      manager.require('warehouse.configure', 'w-other');
    }).toThrow(NotFoundError);
    expect(() => {
      manager.require('warehouse.configure', W2);
    }).toThrow(ForbiddenError);
    expect(() => {
      manager.require('warehouse.configure', W1);
    }).not.toThrow();
  });

  it('merges GLOBAL and warehouse keys for the portal', () => {
    expect(manager.keysAt(W1)).toEqual(['dashboard.view', 'warehouse.configure', 'warehouse.view']);
    expect(manager.holdsAnywhere('warehouse.configure')).toBe(true);
    expect(manager.holdsAnywhere('warehouse.create')).toBe(false);
  });
});
