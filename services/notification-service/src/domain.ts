/**
 * Notification enums as plain string unions (mirror of the Prisma enums in
 * prisma/schema/notification; only repositories import the database client). The arrays drive
 * Joi validation and Swagger.
 */

export const APPS = ['CUSTOMER', 'ADMIN', 'WAREHOUSE', 'LOGISTICS', 'VENDOR'] as const;
export type NotificationApp = (typeof APPS)[number];

export const CATEGORIES = [
  'ORDER',
  'PAYMENT',
  'REFUND',
  'INVENTORY',
  'ACCOUNT',
  'SECURITY',
  'PROMO',
  'SYSTEM',
] as const;
export type NotificationCategory = (typeof CATEGORIES)[number];

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export type NotificationPriority = (typeof PRIORITIES)[number];

export const CHANNELS = ['IN_APP', 'PUSH', 'EMAIL', 'SMS'] as const;
export type NotificationChannel = (typeof CHANNELS)[number];

export type NotificationAudience = 'USER' | 'USERS' | 'PERMISSION' | 'APP';

export type NotificationStatus = 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'CANCELLED' | 'EXPIRED';

export const DELIVERY_STATUSES = [
  'PENDING',
  'SENDING',
  'SENT',
  'RETRYING',
  'FAILED',
  'SKIPPED',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
