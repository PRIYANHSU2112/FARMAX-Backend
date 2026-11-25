// Public API of the docks feature. Other features import ONLY from here.
export { docksModule } from './docks.module.js';
export type { DocksService } from './docks.service.js';
export { isOverlapViolation } from './docks.service.js';
export type { BookingRow as DockBookingRow, DoorRow as DockDoorRow } from './docks.repository.js';
export { ADMIN_DOCKS_TAG } from './docks.docs.js';
