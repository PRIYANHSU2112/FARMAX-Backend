// Public API of the farms feature. Other features import ONLY from here.
export { farmsAdminModule, farmsInternalModule, farmsModule } from './farms.module.js';
export type { FarmsService } from './farms.service.js';
export type { DuplicateMatch, DuplicateSignal } from './farm.dedupe.js';
export type {
  FarmContext,
  FarmStatus,
  FarmView,
  OwnerSegment,
  ReaderContext,
} from './farms.types.js';
export { ADMIN_FARMS_TAG, FARMS_TAG, farmExample, farmSchema } from './farms.docs.js';
