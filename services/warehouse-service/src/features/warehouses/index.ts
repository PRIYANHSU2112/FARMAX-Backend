// Public API of the warehouses feature. Other features import ONLY from here.
export { warehousesModule } from './warehouses.module.js';
export type { WarehousesService } from './warehouses.service.js';
export type { SetupFacts } from './warehouses.rules.js';
export { usedPct } from './warehouses.rules.js';
export type { TempClass, WarehouseRecord } from './warehouses.types.js';
export { TEMP_CLASSES } from './warehouses.types.js';
export {
  STATES,
  TEMP_CLASS_INFO,
  TYPE_LABELS,
  STATUS_LABELS,
  stateName,
} from './warehouses.lookups.js';
export { ADMIN_WAREHOUSES_TAG } from './warehouses.docs.js';
