import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';
import type { EventHandlerMap } from '../../adapters/events.js';
import { createStockEventHandlers } from './stock.events.js';
import { StockEngine } from './stock.engine.js';
import { StockRepository } from './stock.repository.js';
import { stockRoutes } from './stock.routes.js';
import { StockService } from './stock.service.js';
import { StockSettings } from './stock.settings.js';

declare module '@fastify/awilix' {
  interface Cradle {
    stockRepository: StockRepository;
    stockSettings: StockSettings;
    stockEngine: StockEngine;
    stockService: StockService;
    stockEventHandlers: EventHandlerMap;
  }
}

/** D-57a stock (W4 + interim inbound): warehouse panel `/wms/stock/*`. */
export const stockModule = defineModule({
  name: 'stock',
  prefix: '/wms',
  register: (container) => {
    container.register({
      stockRepository: asClass(StockRepository).singleton(),
      stockSettings: asClass(StockSettings).singleton(),
      stockEngine: asClass(StockEngine).singleton(),
      stockService: asClass(StockService).singleton(),
      stockEventHandlers: asFunction(createStockEventHandlers).singleton(),
    });
  },
  routes: stockRoutes('panel'),
});

/** Same handlers for the admin panel (`/admin/wms/stock/*`, GLOBAL grants) + admin-only routes. */
export const stockAdminModule = defineModule({
  name: 'stock-admin',
  prefix: '/admin/wms',
  routes: stockRoutes('admin'),
});
