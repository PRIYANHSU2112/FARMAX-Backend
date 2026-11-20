import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import type { DeliveryChannel } from '../../adapters/queues.js';
import type { AudienceSpec } from '../audience/index.js';
import type { Actor } from '../audit/index.js';
import type {
  AdminDeliveryView,
  AdminListQuery,
  AdminNotificationDetail,
  Analytics,
  DeliveryListQuery,
  SendInput,
} from './notifications.admin.types.js';

type Deps = Pick<
  Cradle,
  | 'notificationsAdminRepository'
  | 'notificationsService'
  | 'auditService'
  | 'runInTransaction'
  | 'queues'
>;

/** Apps whose users are staff: the only ones a PERMISSION audience makes sense for. */
const STAFF_APPS = new Set(['ADMIN', 'WAREHOUSE']);
const MAX_ANALYTICS_DAYS = 92;
const BULK_RETRY_LIMIT = 1000;

/** Staff operations: send / schedule / cancel, delivery DLQ + retry, analytics. All audited. */
export class NotificationsAdminService {
  constructor(private readonly deps: Deps) {}

  /**
   * Sends (or schedules) a notification. Idempotent per (staff user, Idempotency-Key): a replay
   * returns the first result (`replayed: true`) and creates nothing. Explicit user lists up to
   * 500 are created inline; larger / staff / app-wide audiences fan out in the background.
   */
  async send(
    actor: Actor,
    idempotencyKey: string,
    input: SendInput,
  ): Promise<{ notification: AdminNotificationDetail; replayed: boolean }> {
    const { notificationsAdminRepository: repo, notificationsService, auditService } = this.deps;
    const dedupeKey = `admin:${actor.userId ?? 'system'}:${idempotencyKey}`;
    const existing = await repo.findIdByDedupeKey(dedupeKey);
    if (existing !== null) return { notification: await this.get(existing), replayed: true };

    const audience = toSpec(input);
    if (
      input.expiresAt !== undefined &&
      input.scheduledFor !== undefined &&
      input.expiresAt <= input.scheduledFor
    )
      throw new ValidationError([{ path: 'expiresAt', message: 'must be after scheduledFor' }]);

    const accepted = await this.deps.runInTransaction(async (tx) => {
      const a = await notificationsService.accept(tx, {
        dedupeKey,
        category: input.category,
        priority: input.priority,
        app: input.app,
        audience,
        channels: input.channels,
        templateKey: input.templateKey,
        vars: input.vars,
        ...(input.data === undefined ? {} : { data: input.data }),
        ...(input.data?.entityType === undefined ? {} : { entityType: input.data.entityType }),
        ...(input.data?.entityId === undefined ? {} : { entityId: input.data.entityId }),
        source: 'admin',
        ...(actor.userId === null ? {} : { createdBy: actor.userId }),
        reason: input.reason,
        ...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      });
      if (a !== null)
        await auditService.record(tx, actor, {
          action: input.scheduledFor === undefined ? 'notification.send' : 'notification.schedule',
          targetType: 'notification',
          targetId: a.notificationId,
          after: {
            app: input.app,
            category: input.category,
            priority: input.priority,
            audienceType: input.audience.type,
            audienceSize: input.audience.userIds?.length ?? null,
            permission: input.audience.permission ?? null,
            channels: input.channels,
            templateKey: input.templateKey,
            scheduledFor: input.scheduledFor?.toISOString() ?? null,
          },
          reason: input.reason,
        });
      return a;
    });
    if (accepted === null) {
      // Lost a race with the same key: return the winner.
      const id = await repo.findIdByDedupeKey(dedupeKey);
      if (id === null) throw new ConflictError('Concurrent request with the same Idempotency-Key');
      return { notification: await this.get(id), replayed: true };
    }
    await notificationsService.afterCommit(accepted);
    return { notification: await this.get(accepted.notificationId), replayed: false };
  }

  list(query: AdminListQuery) {
    return this.deps.notificationsAdminRepository.list(query);
  }

  async get(id: string): Promise<AdminNotificationDetail> {
    const repo = this.deps.notificationsAdminRepository;
    const n = await repo.get(id);
    if (n === null) throw new NotFoundError('Notification not found');
    return { ...n, deliveryStats: await repo.deliveryStats(id) };
  }

  /**
   * Stops a SCHEDULED notification, or a fan-out still in progress (recipients already created
   * keep their inbox entry; their pending deliveries are skipped as CANCELLED).
   */
  async cancel(actor: Actor, id: string, reason: string): Promise<AdminNotificationDetail> {
    const { notificationsAdminRepository: repo, auditService, runInTransaction } = this.deps;
    const before = await this.get(id);
    const cancelled = await repo.cancel(id, actor.userId);
    if (!cancelled)
      throw new ConflictError('Only scheduled or still-sending notifications can be cancelled', {
        details: { reason: 'NOT_CANCELLABLE', status: before.status },
      });
    await runInTransaction((tx) =>
      auditService.record(tx, actor, {
        action: 'notification.cancel',
        targetType: 'notification',
        targetId: id,
        before: { status: before.status },
        after: { status: 'CANCELLED' },
        reason,
      }),
    );
    return this.get(id);
  }

  listDeliveries(query: DeliveryListQuery): Promise<{
    items: AdminDeliveryView[];
    nextCursor: string | null;
  }> {
    return this.deps.notificationsAdminRepository.listDeliveries(query);
  }

  /** FAILED → PENDING (fresh attempt budget) and enqueued. 409 when not FAILED / not retryable. */
  async retryDelivery(actor: Actor, id: string, reason: string): Promise<{ retried: number }> {
    const repo = this.deps.notificationsAdminRepository;
    const found = await repo.findDelivery(id);
    if (found === null) throw new NotFoundError('Delivery not found');
    const refs = await repo.requeueFailed({ id, limit: 1 });
    if (refs.length === 0)
      throw new ConflictError('Only FAILED deliveries of live notifications can be retried', {
        details: { reason: 'NOT_RETRYABLE', status: found.status },
      });
    await this.afterRequeue(actor, refs, 'delivery', id, reason);
    return { retried: 1 };
  }

  /** Bulk retry (≤ 1000 per call) of FAILED deliveries, optionally of one notification / channel. */
  async retryFailed(
    actor: Actor,
    filter: { notificationId?: string; channel?: DeliveryChannel },
    reason: string,
  ): Promise<{ retried: number }> {
    const refs = await this.deps.notificationsAdminRepository.requeueFailed({
      ...filter,
      limit: BULK_RETRY_LIMIT,
    });
    if (refs.length > 0)
      await this.afterRequeue(
        actor,
        refs,
        'notification',
        filter.notificationId ?? 'bulk',
        reason,
        filter,
      );
    return { retried: refs.length };
  }

  analytics(from: Date | undefined, to: Date | undefined): Promise<Analytics> {
    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - 7 * 86_400_000);
    if (start >= end) throw new ValidationError([{ path: 'from', message: 'must be before to' }]);
    if (end.getTime() - start.getTime() > MAX_ANALYTICS_DAYS * 86_400_000)
      throw new ValidationError([
        { path: 'from', message: `range must be at most ${String(MAX_ANALYTICS_DAYS)} days` },
      ]);
    return this.deps.notificationsAdminRepository.analytics(start, end);
  }

  private async afterRequeue(
    actor: Actor,
    refs: {
      id: string;
      channel: DeliveryChannel;
      priority: AdminDeliveryView['priority'];
      attempts: number;
    }[],
    targetType: 'delivery' | 'notification',
    targetId: string,
    reason: string,
    filter?: object,
  ): Promise<void> {
    await this.deps.runInTransaction((tx) =>
      this.deps.auditService.record(tx, actor, {
        action: 'delivery.retry',
        targetType,
        targetId,
        after: { retried: refs.length, ...(filter ?? {}) },
        reason,
      }),
    );
    await this.deps.queues.enqueueDeliveries(refs).catch(() => undefined);
  }
}

/** API audience → internal spec, with the app / audience rules. */
const toSpec = (input: SendInput): AudienceSpec => {
  const a = input.audience;
  switch (a.type) {
    case 'USER':
    case 'USERS':
      return { kind: 'users', userIds: [...new Set(a.userIds ?? [])] };
    case 'PERMISSION':
      if (!STAFF_APPS.has(input.app))
        throw new ValidationError([
          {
            path: 'audience.type',
            message: 'PERMISSION audiences are only for the ADMIN or WAREHOUSE app',
          },
        ]);
      return {
        kind: 'permission',
        permission: a.permission ?? '',
        warehouseId: a.warehouseId ?? null,
      };
    case 'APP':
      return { kind: 'app' };
  }
};
