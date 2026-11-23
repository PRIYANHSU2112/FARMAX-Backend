import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { createWarehouseEventHandlers } from './warehouses.events.js';
import { WarehousesRepository } from './warehouses.repository.js';
import { WarehousesService } from './warehouses.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    warehousesRepository: WarehousesRepository;
    warehousesService: WarehousesService;
    warehouseEventHandlers: EventHandlerMap;
  }
}

/**
 * Warehouse projection (no routes since D-56): warehouse-service owns the master data and the
 * admin screens (`/v1/admin/warehouses`); this copy feeds allocation and stock movements.
 */
export const warehousesModule = defineModule({
  name: 'warehouses',
  register: (container) => {
    container.register({
      warehousesRepository: asClass(WarehousesRepository).singleton(),
      warehousesService: asClass(WarehousesService).singleton(),
      warehouseEventHandlers: asFunction(createWarehouseEventHandlers).singleton(),
    });
  },
});
