import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';
import type { EventHandlerMap } from '../../adapters/events.js';
import { createStockEventHandlers } from './stock.events.js';
import { StockCutover } from './stock.cutover.js';
import { StockEngine } from './stock.engine.js';
import { StockJobs } from './stock.jobs.js';
import { StockQualityRepository } from './stock.quality.repository.js';
import { StockQuality } from './stock.quality.js';
import { stockInternalRoutes } from './stock.internal.routes.js';
import { StockQueries } from './stock.queries.js';
import { StockReadRepository } from './stock.read.repository.js';
import { stockReadRoutes } from './stock.read.routes.js';
import { StockRepository } from './stock.repository.js';
import type { Audience } from '../../middleware/guards.js';
import type { FastifyPluginAsync } from 'fastify';
import { stockRoutes } from './stock.routes.js';
import { StockService } from './stock.service.js';
import { StockSettings } from './stock.settings.js';
import { StockVendors } from './stock.vendors.js';

/** Commands + W4 reads for one audience. */
const routesFor =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    await stockRoutes(aud)(app, {});
    await stockReadRoutes(aud)(app, {});
  };

declare module '@fastify/awilix' {
  interface Cradle {
    stockRepository: StockRepository;
    stockSettings: StockSettings;
    stockEngine: StockEngine;
    stockService: StockService;
    stockCutover: StockCutover;
    stockJobs: StockJobs;
    stockVendors: StockVendors;
    stockReadRepository: StockReadRepository;
    stockQueries: StockQueries;
    stockEventHandlers: EventHandlerMap;
    stockQualityRepository: StockQualityRepository;
    stockQuality: StockQuality;
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
      stockCutover: asClass(StockCutover).singleton(),
      stockJobs: asClass(StockJobs).singleton(),
      stockVendors: asClass(StockVendors).singleton(),
      stockReadRepository: asClass(StockReadRepository).singleton(),
      stockQueries: asClass(StockQueries).singleton(),
      stockEventHandlers: asFunction(createStockEventHandlers).singleton(),
      stockQualityRepository: asClass(StockQualityRepository).singleton(),
      stockQuality: asClass(StockQuality).singleton(),
    });
  },
  routes: routesFor('panel'),
});

/** D-60 service-to-service: `/internal/wms/units/:qrCode/trace` (never routed by the gateway). */
export const stockInternalModule = defineModule({
  name: 'stock-internal',
  prefix: '/internal/wms',
  routes: stockInternalRoutes,
});

/** Same handlers for the admin panel (`/admin/wms/stock/*`, GLOBAL grants) + admin-only routes. */
export const stockAdminModule = defineModule({
  name: 'stock-admin',
  prefix: '/admin/wms',
  routes: routesFor('admin'),
});
