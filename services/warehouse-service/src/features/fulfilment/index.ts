// Public API of the fulfilment feature. Other features import ONLY from here.
export {
  customerShipmentsModule,
  driverLinkModule,
  fulfilmentAdminModule,
  fulfilmentModule,
} from './fulfilment.module.js';
export { CUSTOMER_TAG, DELIVERY_AREA, DRIVER_TAG } from './fulfilment.delivery.docs.js';
export { EXCEPTIONS_AREA, FLOOR_AREA, FULFILMENT_AREA } from './fulfilment.docs.js';
export type { FulfilmentOrders } from './fulfilment.orders.js';
export type { FulfilmentQueries } from './fulfilment.queries.js';
export type { FulfilmentSync } from './fulfilment.sync.js';
export { slaDueAt } from './fulfilment.rules.js';
export { AMEND_AREA, SPLIT_AREA } from './fulfilment.split.docs.js';
