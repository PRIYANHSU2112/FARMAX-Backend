import type {
  DeliveryStatus,
  NotificationApp,
  NotificationAudience,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
} from '../../domain.js';
import type { TemplateVars } from '../templates/index.js';

/** A notification as staff see it (ids only; never addresses or tokens). */
export interface AdminNotificationView {
  id: string;
  status: NotificationStatus;
  source: string;
  app: NotificationApp;
  category: NotificationCategory;
  priority: NotificationPriority;
  audienceType: NotificationAudience;
  audience: unknown;
  channels: NotificationChannel[];
  templateKey: string;
  templateVersion: number | null;
  title: string;
  body: string;
  data: unknown;
  entityType: string | null;
  entityId: string | null;
  sourceEventId: string | null;
  createdBy: string | null;
  reason: string | null;
  scheduledFor: Date | null;
  expiresAt: Date | null;
  recipientCount: number;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  createdAt: Date;
}

export interface AdminNotificationDetail extends AdminNotificationView {
  /** Rendered per channel (what was / will be sent). */
  content: unknown;
  /** Deliveries per channel per status, e.g. { PUSH: { SENT: 120, SKIPPED: 4 } }. */
  deliveryStats: Record<string, Partial<Record<DeliveryStatus, number>>>;
}

export interface AdminListQuery {
  status?: NotificationStatus;
  source?: 'event' | 'admin';
  app?: NotificationApp;
  category?: NotificationCategory;
  templateKey?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface SendInput {
  app: NotificationApp;
  category: NotificationCategory;
  priority: NotificationPriority;
  audience: {
    type: NotificationAudience;
    userIds?: string[];
    permission?: string;
    warehouseId?: string;
  };
  channels: ('PUSH' | 'EMAIL' | 'SMS')[];
  templateKey: string;
  vars: TemplateVars;
  data?: { entityType?: string; entityId?: string };
  scheduledFor?: Date;
  expiresAt?: Date;
  reason: string;
}

export interface AdminDeliveryView {
  id: string;
  notificationId: string;
  title: string;
  userId: string;
  channel: NotificationChannel;
  priority: NotificationPriority;
  status: DeliveryStatus;
  attempts: number;
  skipReason: string | null;
  lastError: string | null;
  provider: string | null;
  providerMessageId: string | null;
  nextAttemptAt: Date | null;
  sentAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
}

export interface DeliveryListQuery {
  status?: DeliveryStatus;
  channel?: 'PUSH' | 'EMAIL' | 'SMS';
  notificationId?: string;
  userId?: string;
  cursor?: string;
  limit: number;
}

export interface Analytics {
  from: Date;
  to: Date;
  notifications: { category: NotificationCategory; source: string; count: number }[];
  deliveries: {
    channel: NotificationChannel;
    sent: number;
    failed: number;
    skipped: number;
    inFlight: number;
    /** sent / (sent + failed); null when nothing finished. */
    successRate: number | null;
    avgLatencySeconds: number | null;
  }[];
}
