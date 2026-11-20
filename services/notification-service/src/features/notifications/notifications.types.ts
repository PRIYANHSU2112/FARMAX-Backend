import type {
  NotificationApp,
  NotificationCategory,
  NotificationAudience,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
} from '../../domain.js';
import type { AudienceSpec } from '../audience/index.js';
import type { ChannelContent, ExternalChannel, TemplateVars } from '../templates/index.js';

/** What a rule (event) or an admin send asks for. Rendered + stored once by `accept`. */
export interface NotificationDraft {
  /** Idempotency: the same key never creates a second notification. ≤ 160 chars. */
  dedupeKey: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  app: NotificationApp;
  audience: AudienceSpec;
  /** External channels wanted (in-app is always on); preferences may drop some per user. */
  channels: ExternalChannel[];
  templateKey: string;
  vars: TemplateVars;
  /** Deep link for the apps (ids only, never personal data). */
  data?: Record<string, string | number | null>;
  entityType?: string;
  entityId?: string;
  source: 'event' | 'admin';
  sourceEventId?: string;
  createdBy?: string;
  reason?: string;
  scheduledFor?: Date;
  expiresAt?: Date;
}

/** One inbox entry as the apps see it (uid=197609(HP) gid=197121 groups=197121 = the notification id, same for every recipient). */
export interface InboxItem {
  id: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  title: string;
  body: string;
  /** Deep link: entityType / entityId (+ ids such as orderNo). */
  data: unknown;
  read: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export interface InboxQuery {
  unread?: boolean;
  category?: NotificationCategory;
  cursor?: string;
  limit: number;
}

/** A notification row to insert (the repository maps the JSON columns). */
export interface NewNotification {
  id: string;
  dedupeKey: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  app: NotificationApp;
  audienceType: NotificationAudience;
  audience: Record<string, unknown>;
  channels: NotificationChannel[];
  templateKey: string;
  templateVersion: number;
  title: string;
  body: string;
  content: ChannelContent;
  data: Record<string, string | number | null>;
  entityType: string | null;
  entityId: string | null;
  source: 'event' | 'admin';
  sourceEventId: string | null;
  createdBy: string | null;
  reason: string | null;
  status: NotificationStatus;
  scheduledFor: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/** The notification fields fan-out needs (row-locked during a page). */
export interface FanoutHeader {
  id: string;
  status: NotificationStatus;
  app: NotificationApp;
  category: NotificationCategory;
  priority: NotificationPriority;
  channels: NotificationChannel[];
  audienceType: NotificationAudience;
  audience: unknown;
  fanoutCursor: string | null;
  title: string;
  body: string;
  data: unknown;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Rows created in one transaction (inbox rows + their pending deliveries). */
export interface Dispatched {
  notificationId: string;
  app: NotificationApp;
  createdAt: Date;
  /** The inbox item every recipient sees (pushed live over SSE). */
  item: InboxItem;
  recipients: { id: string; userId: string }[];
  deliveries: {
    id: string;
    userId: string;
    channel: ExternalChannel;
    priority: NotificationPriority;
  }[];
}

export interface Accepted {
  notificationId: string;
  status: NotificationStatus;
  category: NotificationCategory;
  source: 'event' | 'admin';
  /** Set when recipients were created inline (small explicit audiences). */
  dispatched: Dispatched | null;
}
