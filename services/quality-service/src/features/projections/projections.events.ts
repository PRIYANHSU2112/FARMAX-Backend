import type { WarehouseReceiptCreatedV1, WarehouseShipmentBatchesV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

/**
 * Receipt → projections + AUTO sample in the same inbox transaction (D-60 point 1).
 * Shipment → buyer rows + a recall notice when the batch is already recalled (point 2).
 */
export const createProjectionEventHandlers = ({
  projectionsService,
  samplesService,
  releaseService,
}: Pick<Cradle, 'projectionsService' | 'samplesService' | 'releaseService'>): EventHandlerMap => ({
  'warehouse.receipt_created.v1': async (e, tx) => {
    const d = e.data as WarehouseReceiptCreatedV1;
    await projectionsService.applyReceipt(tx, d);
    await releaseService.ensureStates(tx, [...new Set(d.lines.map((l) => l.batchId))]);
    await samplesService.autoFromReceipt(tx, d);
  },
  'warehouse.shipment_batches.v1': async (e, tx) => {
    const d = e.data as WarehouseShipmentBatchesV1;
    const batchIds = await projectionsService.applyShipment(tx, d);
    await releaseService.noticeLateBuyer(tx, d, batchIds, e.correlationId);
  },
});
