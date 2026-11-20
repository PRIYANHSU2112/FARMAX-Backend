import { NotFoundError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import type { NotificationApp } from '../../domain.js';
import type { InboxItem, InboxQuery } from './notifications.types.js';

type Deps = Pick<Cradle, 'notificationsRepository' | 'liveHub'>;

/** The caller's own inbox (every method is scoped by the token's user id + allowed app). */
export class InboxService {
  constructor(private readonly deps: Deps) {}

  list(userId: string, app: NotificationApp, query: InboxQuery) {
    return this.deps.notificationsRepository.listInbox(userId, app, query);
  }

  async get(userId: string, app: NotificationApp, id: string): Promise<InboxItem> {
    const item = await this.deps.notificationsRepository.findInboxItem(userId, app, id);
    if (item === null) throw new NotFoundError('Notification not found');
    return item;
  }

  unreadCount(userId: string, app: NotificationApp): Promise<number> {
    return this.deps.notificationsRepository.countUnread(userId, app);
  }

  /** Idempotent. Other open devices get the new badge count live. */
  async markRead(userId: string, app: NotificationApp, id: string) {
    const changed = await this.deps.notificationsRepository.markRead(userId, app, id, new Date());
    if (changed === null) throw new NotFoundError('Notification not found');
    const unreadCount = await this.unreadCount(userId, app);
    if (changed > 0) this.publishCount(userId, app, unreadCount);
    return { id, read: true, unreadCount };
  }

  async markAllRead(userId: string, app: NotificationApp, before: Date | undefined) {
    const now = new Date();
    const updated = await this.deps.notificationsRepository.markAllRead(
      userId,
      app,
      before ?? now,
      now,
    );
    const unreadCount = await this.unreadCount(userId, app);
    if (updated > 0) this.publishCount(userId, app, unreadCount);
    return { updated, unreadCount };
  }

  private publishCount(userId: string, app: NotificationApp, unreadCount: number): void {
    this.deps.liveHub.publish({
      userIds: [userId],
      app,
      event: 'unread_count',
      data: { unreadCount },
    });
  }
}
