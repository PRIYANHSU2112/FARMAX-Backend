import type { DirectoryUserType } from '../../adapters/auth-directory.js';
import type { NotificationApp, NotificationAudience } from '../../domain.js';

/** Who a notification is for. Stored as (`audienceType`, `audience` JSON) on the notification. */
export type AudienceSpec =
  | { kind: 'users'; userIds: string[] }
  /** ACTIVE staff with the permission at GLOBAL scope, or at `warehouseId`. */
  | { kind: 'permission'; permission: string; warehouseId?: string | null }
  /** Every ACTIVE user of the app's user type. */
  | { kind: 'app' };

/** Owner + number of an order (from `order.placed.v1`). */
export interface OrderRef {
  orderId: string;
  orderNo: string;
  userId: string;
}

export interface AudiencePage {
  userIds: string[];
  /** Null = this was the last page. */
  nextCursor: string | null;
}

/** Which user type may read an app's notifications (also the APP audience). */
export const APP_USER_TYPE: Readonly<Record<NotificationApp, DirectoryUserType>> = {
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'INTERNAL',
  WAREHOUSE: 'INTERNAL',
  LOGISTICS: 'LOGISTICS_PARTNER',
  VENDOR: 'VENDOR',
};

/** Apps a user type may read. */
export const appsOf = (userType: string): NotificationApp[] =>
  (Object.keys(APP_USER_TYPE) as NotificationApp[]).filter(
    (app) => APP_USER_TYPE[app] === userType,
  );

export interface AudienceColumns {
  audienceType: NotificationAudience;
  audience: Record<string, unknown>;
}
