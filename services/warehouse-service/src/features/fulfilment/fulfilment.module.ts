import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { createFulfilmentEventHandlers } from './fulfilment.events.js';
import { FulfilmentDelivery } from './fulfilment.delivery.js';
import { customerShipmentRoutes, driverRoutes } from './fulfilment.delivery.routes.js';
import { FulfilmentExceptions } from './fulfilment.exceptions.js';
import { FulfilmentFefo } from './fulfilment.fefo.js';
import { ShipmentFlow } from './fulfilment.flow.js';
import { FulfilmentFloor } from './fulfilment.floor.js';
import { FulfilmentJobs } from './fulfilment.jobs.js';
import { FulfilmentOrders } from './fulfilment.orders.js';
import { FulfilmentQueries } from './fulfilment.queries.js';
import { FulfilmentReadRepository } from './fulfilment.read.repository.js';
import { FulfilmentRepository } from './fulfilment.repository.js';
import { fulfilmentRoutes } from './fulfilment.routes.js';
import { FulfilmentSettings } from './fulfilment.settings.js';
import { BackordersRepository } from './fulfilment.backorders.repository.js';
import { FulfilmentSplit } from './fulfilment.split.js';
import { FulfilmentAmendments } from './fulfilment.amendments.js';
import { FulfilmentSync } from './fulfilment.sync.js';

declare module '@fastify/awilix' {
  interface Cradle {
    fulfilmentRepository: FulfilmentRepository;
    fulfilmentReadRepository: FulfilmentReadRepository;
    shipmentFlow: ShipmentFlow;
    fulfilmentSettings: FulfilmentSettings;
    fulfilmentSync: FulfilmentSync;
    fulfilmentOrders: FulfilmentOrders;
    fulfilmentFefo: FulfilmentFefo;
    fulfilmentFloor: FulfilmentFloor;
    fulfilmentExceptions: FulfilmentExceptions;
    fulfilmentQueries: FulfilmentQueries;
    fulfilmentJobs: FulfilmentJobs;
    fulfilmentDelivery: FulfilmentDelivery;
    fulfilmentSplit: FulfilmentSplit;
    fulfilmentAmendments: FulfilmentAmendments;
    backordersRepository: BackordersRepository;
    fulfilmentEventHandlers: EventHandlerMap;
  }
}

/** D-57b order fulfilment (W3): warehouse panel `/wms/fulfilment/*`. */
export const fulfilmentModule = defineModule({
  name: 'fulfilment',
  prefix: '/wms',
  register: (container) => {
    container.register({
      fulfilmentRepository: asClass(FulfilmentRepository).singleton(),
      fulfilmentReadRepository: asClass(FulfilmentReadRepository).singleton(),
      shipmentFlow: asClass(ShipmentFlow).singleton(),
      fulfilmentSettings: asClass(FulfilmentSettings).singleton(),
      fulfilmentSync: asClass(FulfilmentSync).singleton(),
      fulfilmentOrders: asClass(FulfilmentOrders).singleton(),
      fulfilmentFefo: asClass(FulfilmentFefo).singleton(),
      fulfilmentFloor: asClass(FulfilmentFloor).singleton(),
      fulfilmentExceptions: asClass(FulfilmentExceptions).singleton(),
      fulfilmentQueries: asClass(FulfilmentQueries).singleton(),
      fulfilmentJobs: asClass(FulfilmentJobs).singleton(),
      fulfilmentSplit: asClass(FulfilmentSplit).singleton(),
      fulfilmentAmendments: asClass(FulfilmentAmendments).singleton(),
      backordersRepository: asClass(BackordersRepository).singleton(),
      fulfilmentDelivery: asClass(FulfilmentDelivery).singleton(),
      fulfilmentEventHandlers: asFunction(createFulfilmentEventHandlers).singleton(),
    });
  },
  routes: fulfilmentRoutes('panel'),
});

/** Same handlers for the admin panel (`/admin/wms/*`, GLOBAL) + admin-only settings. */
export const fulfilmentAdminModule = defineModule({
  name: 'fulfilment-admin',
  prefix: '/admin/wms',
  routes: fulfilmentRoutes('admin'),
});

/** Public 3PL driver trip links (`/v1/driver/*`, §2a.8). */
export const driverLinkModule = defineModule({
  name: 'driver-link',
  prefix: '/driver',
  routes: driverRoutes,
});

/** Customer app (`/v1/shipments`): own shipments + delivery OTP. */
export const customerShipmentsModule = defineModule({
  name: 'customer-shipments',
  prefix: '/shipments',
  routes: customerShipmentRoutes,
});
