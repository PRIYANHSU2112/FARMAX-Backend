// Public API of the stock feature. Other features import ONLY from here.
export { stockInternalModule, stockModule } from './stock.module.js';
export type { StockService } from './stock.service.js';
export type { StockMove } from './stock.types.js';
export { byLockOrder } from './stock.rules.js';
export { ADMIN_STOCK_TAG } from './stock.docs.js';
export type { WarehouseStats } from './stock.stats.js';
