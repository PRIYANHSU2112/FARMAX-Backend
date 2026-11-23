import { ForbiddenError, NotFoundError } from '@farmx/common/errors';

import type { Grants } from '../adapters/auth.js';

/** Every warehouse (GLOBAL grant) or exactly these ids. */
export type WarehouseScope = 'ALL' | readonly string[];

/**
 * A caller's grants (D-56): GLOBAL keys work everywhere, WAREHOUSE keys at their warehouse only.
 * A warehouse the caller cannot even VIEW is reported as 404 (its existence is not revealed);
 * a visible warehouse without the needed key is 403.
 */
export class Access {
  private readonly global: ReadonlySet<string>;
  private readonly scoped: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(grants: Grants) {
    this.global = new Set(grants.permissions);
    this.scoped = new Map(
      Object.entries(grants.warehouses).map(([id, keys]) => [id, new Set(keys)] as const),
    );
  }

  /** Held globally (central administration). */
  isGlobal(key: string): boolean {
    return this.global.has(key);
  }

  can(key: string, warehouseId: string): boolean {
    return this.global.has(key) || this.scoped.get(warehouseId)?.has(key) === true;
  }

  holdsAnywhere(key: string): boolean {
    if (this.global.has(key)) return true;
    for (const keys of this.scoped.values()) if (keys.has(key)) return true;
    return false;
  }

  /** Where `key` applies: everywhere, or the listed warehouses. */
  scope(key: string): WarehouseScope {
    if (this.global.has(key)) return 'ALL';
    return [...this.scoped].filter(([, keys]) => keys.has(key)).map(([id]) => id);
  }

  /** Effective keys at one warehouse (GLOBAL ∪ that warehouse), sorted. */
  keysAt(warehouseId: string): string[] {
    return [...new Set([...this.global, ...(this.scoped.get(warehouseId) ?? [])])].sort();
  }

  /** 404 when the warehouse is not visible to the caller, 403 when the key is missing there. */
  require(key: string, warehouseId: string): void {
    if (this.can(key, warehouseId)) return;
    if (!this.can('warehouse.view', warehouseId)) throw new NotFoundError('Warehouse');
    throw new ForbiddenError();
  }
}
