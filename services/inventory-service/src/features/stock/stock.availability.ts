import { INVENTORY_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { emitInventoryEvent } from '../../adapters/events.js';
import {
  byLockOrder,
  lowStockCrossing,
  networkAvailability,
  nodeAvailability,
  sellableOf,
} from './stock.rules.js';
import type { LevelRow } from './stock.types.js';

const BATCH = 500;

type Deps = Pick<Cradle, 'stockRepository' | 'warehousesService' | 'runInTransaction' | 'logger'>;

/**
 * BullMQ job (every 2 s, see adapters/jobs.ts). Drains `inventory_availability_dirty` and, per
 * variant, recomputes network availability. Events are DEDUPLICATED:
 *   - `availability_changed.v1` only when availableQty / inStock / lowStock differ from the last
 *     published state (sequence +1 per variant, monotonic);
 *   - `low_stock.v1` only when a warehouse × variant CROSSES down to its reorder level.
 * One transaction per batch: a failure puts the dirty marks back (rollback) for the next tick.
 */
export class AvailabilityPublisher {
  constructor(private readonly deps: Deps) {}

  async publishDirty(): Promise<{ variants: number; events: number }> {
    const allocatable = new Set(await this.deps.warehousesService.allocatableIds());
    return this.deps.runInTransaction(async (tx) => {
      const { stockRepository: repo } = this.deps;
      const variantIds = await repo.drainDirty(tx, BATCH);
      if (variantIds.length === 0) return { variants: 0, events: 0 };

      const levels = await repo.levelsOf(tx, variantIds);
      const states = new Map((await repo.lockStates(tx, variantIds)).map((s) => [s.variantId, s]));
      const byVariant = new Map<string, LevelRow[]>();
      for (const l of levels)
        byVariant.set(l.variantId, [...(byVariant.get(l.variantId) ?? []), l]);

      let events = 0;
      const correlationId = `availability:${new Date().toISOString()}`;
      // Flag flips, applied after the loop one row at a time in (warehouseId, variantId) order —
      // the same lock order reservations use, so the publisher never deadlocks with them.
      const flips: { warehouseId: string; variantId: string; id: string; flag: boolean }[] = [];

      for (const variantId of variantIds) {
        const rows = byVariant.get(variantId) ?? [];
        const now = networkAvailability(rows, allocatable);
        const nodes = nodeAvailability(rows, allocatable);
        const prev = states.get(variantId);
        if (
          prev?.availableQty !== now.availableQty ||
          prev.inStock !== now.inStock ||
          prev.lowStock !== now.lowStock ||
          prev.nodeStockKey !== nodes.key
        ) {
          const sequence = (prev?.sequence ?? 0n) + 1n;
          await repo.saveState(tx, { variantId, ...now, sequence, nodeStockKey: nodes.key });
          await emitInventoryEvent(
            tx,
            INVENTORY_EVENTS.availabilityChanged,
            { variantId, ...now, byNode: nodes.byNode, sequence: Number(sequence) },
            correlationId,
          );
          events += 1;
        }
        for (const l of rows) {
          const sellable = sellableOf(l);
          const next = lowStockCrossing(sellable, l.reorderLevel, l.lowStockAlerted);
          if (next.flag !== l.lowStockAlerted)
            flips.push({ warehouseId: l.warehouseId, variantId, id: l.id, flag: next.flag });
          if (next.alert) {
            await emitInventoryEvent(
              tx,
              INVENTORY_EVENTS.lowStock,
              {
                variantId,
                warehouseId: l.warehouseId,
                availableQty: sellable,
                threshold: l.reorderLevel,
              },
              correlationId,
            );
            events += 1;
          }
        }
      }
      flips.sort(byLockOrder);
      for (const f of flips) await repo.setLowStockFlag(tx, [f.id], f.flag);
      if (events > 0)
        this.deps.logger.debug({ variants: variantIds.length, events }, 'availability published');
      return { variants: variantIds.length, events };
    });
  }
}
