import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import { AvailabilityPublisher } from './stock.availability.js';
import { StockRepository } from './stock.repository.js';
import { stockInternalRoutes } from './stock.internal.routes.js';
import { stockRoutes } from './stock.routes.js';
import { StockService } from './stock.service.js';
import type { EventHandlerMap } from '../../adapters/events.js';
import { WmsSyncService } from './stock.wms.js';
import type { WarehouseStockChangedV1, WarehouseThresholdsChangedV1 } from '@farmx/infra/events';

declare module '@fastify/awilix' {
  interface Cradle {
    stockRepository: StockRepository;
    stockService: StockService;
    availabilityPublisher: AvailabilityPublisher;
    wmsSyncService: WmsSyncService;
    wmsStockEventHandlers: EventHandlerMap;
  }
}

export const stockModule = defineModule({
  name: 'stock',
  prefix: '/admin/inventory',
  register: (container) => {
    container.register({
      stockRepository: asClass(StockRepository).singleton(),
      stockService: asClass(StockService).singleton(),
      availabilityPublisher: asClass(AvailabilityPublisher).singleton(),
      wmsSyncService: asClass(WmsSyncService).singleton(),
      // D-57a: warehouse-service owns physical stock and thresholds.
      wmsStockEventHandlers: asFunction(
        ({ wmsSyncService: sync }: { wmsSyncService: WmsSyncService }): EventHandlerMap => ({
          'warehouse.stock_changed.v1': (e, tx) =>
            sync.applyStockChanged(tx, e.data as WarehouseStockChangedV1),
          'warehouse.thresholds_changed.v1': (e, tx) =>
            sync.applyThresholds(tx, e.data as WarehouseThresholdsChangedV1),
        }),
      ).singleton(),
    });
  },
  routes: stockRoutes,
});

/** `/internal/inventory/warehouse-stats` for warehouse-service (D-56 P3). */
export const stockInternalModule = defineModule({
  name: 'stock-internal',
  prefix: '/internal/inventory',
  routes: stockInternalRoutes,
});
