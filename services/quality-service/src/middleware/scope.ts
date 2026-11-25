import { ForbiddenError, NotFoundError } from '@farmx/common/errors';

import type { Caller } from './guards.js';

/** Prisma `where` fragment limiting rows to the warehouses where the caller holds `key`. */
export const warehouseWhere = (caller: Caller, key: string): { warehouseId?: { in: string[] } } => {
  const scope = caller.access.scope(key);
  return scope === 'ALL' ? {} : { warehouseId: { in: [...scope] } };
};

/**
 * A warehouse-bound row (sample): not visible → 404 `resource` (existence is not revealed);
 * visible without `key` → 403.
 */
export const requireAt = (caller: Caller, key: string, warehouseId: string, resource: string) => {
  if (!caller.access.can('quality.view', warehouseId)) throw new NotFoundError(resource);
  if (!caller.access.can(key, warehouseId)) throw new ForbiddenError();
};

/** A batch-level action by a warehouse-scoped user: they must hold `key` where the batch was received. */
export const requireForBatch = (
  caller: Caller,
  key: string,
  receivingWarehouseIds: readonly string[],
): void => {
  if (caller.access.isGlobal(key)) return;
  if (!receivingWarehouseIds.some((w) => caller.access.can(key, w))) throw new ForbiddenError();
};
