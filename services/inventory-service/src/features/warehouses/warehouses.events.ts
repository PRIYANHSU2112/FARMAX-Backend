import type { WarehouseCoverageReplacedV1, WarehouseUpsertedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

/** warehouse-service events → the warehouse projection (inside the inbox transaction, D-56). */
export const createWarehouseEventHandlers = ({
  warehousesService: svc,
}: Pick<Cradle, 'warehousesService'>): EventHandlerMap => ({
  'warehouse.upserted.v1': (event, tx) => svc.applyUpserted(tx, event.data as WarehouseUpsertedV1),
  'warehouse.coverage_replaced.v1': (event, tx) =>
    svc.applyCoverage(tx, event.data as WarehouseCoverageReplacedV1),
});
