import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import { fromColumns, toColumns } from '../audience/index.js';
import type { ExternalChannel } from '../templates/index.js';
import type {
  Accepted,
  Dispatched,
  FanoutHeader,
  NotificationDraft,
} from './notifications.types.js';

type Deps = Pick<
  Cradle,
  | 'notificationsRepository'
  | 'templatesService'
  | 'preferencesService'
  | 'audienceService'
  | 'runInTransaction'
  | 'queues'
  | 'liveHub'
  | 'metrics'
  | 'logger'
  | 'config'
>;

/** A fan-out page left PROCESSING this long is re-enqueued by the sweep. */
const STALL_MS = 60_000;
/** A fan-out without progress for a day is given up (EXPIRED). */
const STUCK_MS = 24 * 60 * 60_000;

export class NotificationsService {
  constructor(private readonly deps: Deps) {}

  /**
   * Creates a notification inside the caller's transaction (event inbox or admin send):
   * renders once, inserts with ON CONFLICT (dedupeKey) DO NOTHING (null = duplicate), and creates
   * the recipients + pending deliveries inline when the audience is an explicit small list.
   * Larger / staff / app-wide audiences become PROCESSING and are fanned out by a job.
   * Call `afterCommit` with the result once the transaction has committed.
   */
  async accept(tx: Tx, draft: NotificationDraft): Promise<Accepted | null> {
    const { templatesService, audienceService, notificationsRepository } = this.deps;
    const rendered = await templatesService.render(draft.templateKey, draft.channels, draft.vars);
    const inline =
      draft.scheduledFor === undefined ? audienceService.resolveInline(draft.audience) : null;
    const status =
      draft.scheduledFor !== undefined ? 'SCHEDULED' : inline === null ? 'PROCESSING' : 'SENT';
    const header: FanoutHeader = {
      id: uuidv7(),
      status,
      app: draft.app,
      category: draft.category,
      priority: draft.priority,
      channels: rendered.channels,
      ...toColumns(draft.audience),
      fanoutCursor: null,
      title: rendered.title,
      body: rendered.body,
      data: draft.data ?? {},
      expiresAt: draft.expiresAt ?? null,
      createdAt: new Date(),
    };
    const inserted = await notificationsRepository.insertNotification(tx, {
      id: header.id,
      dedupeKey: draft.dedupeKey,
      category: draft.category,
      priority: draft.priority,
      app: draft.app,
      audienceType: header.audienceType,
      audience: header.audience as Record<string, unknown>,
      channels: rendered.channels,
      templateKey: draft.templateKey,
      templateVersion: rendered.version,
      title: rendered.title,
      body: rendered.body,
      content: rendered.content,
      data: draft.data ?? {},
      entityType: draft.entityType ?? null,
      entityId: draft.entityId ?? null,
      source: draft.source,
      sourceEventId: draft.sourceEventId ?? null,
      createdBy: draft.createdBy ?? null,
      reason: draft.reason ?? null,
      status,
      scheduledFor: draft.scheduledFor ?? null,
      expiresAt: header.expiresAt,
      createdAt: header.createdAt,
    });
    if (!inserted) return null;
    const dispatched = inline === null ? null : await this.materialize(tx, header, inline, true);
    return {
      notificationId: header.id,
      status,
      category: draft.category,
      source: draft.source,
      dispatched,
    };
  }

  /** Post-commit side effects of `accept` (never throws: the sweep recovers lost enqueues). */
  async afterCommit(accepted: Accepted): Promise<void> {
    this.deps.metrics.created.inc({ category: accepted.category, source: accepted.source });
    if (accepted.dispatched !== null) this.dispatched(accepted.dispatched);
    if (accepted.status === 'PROCESSING') await this.enqueueFanout(accepted.notificationId);
  }

  /**
   * Fan-out job: resolves the audience page by page (auth-service calls OUTSIDE any transaction),
   * creating recipients + deliveries per page under a row lock. Resumable (`fanoutCursor`) and
   * idempotent (existing recipients are skipped). Throws on retryable failures (BullMQ backoff).
   */
  async fanout(notificationId: string): Promise<void> {
    const { notificationsRepository, audienceService, runInTransaction } = this.deps;
    for (;;) {
      const state = await notificationsRepository.findHeader(notificationId);
      if (state?.status !== 'PROCESSING') return;
      if (state.expiresAt !== null && state.expiresAt <= new Date()) {
        await notificationsRepository.setStatus(notificationId, 'PROCESSING', 'EXPIRED');
        return;
      }
      const spec = fromColumns(state.audienceType, state.audience);
      const page = await audienceService.resolvePage(spec, state.app, state.fanoutCursor);
      const done = page.nextCursor === null;
      const result = await runInTransaction(async (tx) => {
        const locked = await notificationsRepository.lockHeader(tx, notificationId);
        // Another worker advanced it meanwhile: re-read and continue from its cursor.
        if (locked?.status !== 'PROCESSING' || locked.fanoutCursor !== state.fanoutCursor)
          return undefined;
        const dispatched = await this.materialize(tx, locked, page.userIds, false);
        await notificationsRepository.advance(tx, notificationId, {
          added: 0,
          fanoutCursor: page.nextCursor ?? state.fanoutCursor,
          ...(done ? { status: 'SENT' as const } : {}),
        });
        return dispatched;
      });
      if (result === undefined) continue;
      this.dispatched(result);
      if (done) return;
    }
  }

  /** release-scheduled job: due SCHEDULED notifications → fan-out. */
  async releaseScheduled(): Promise<number> {
    const ids = await this.deps.notificationsRepository.releaseDue(200);
    for (const id of ids) await this.enqueueFanout(id);
    return ids.length;
  }

  /** expire job: past expiresAt, or a fan-out stuck for a day (audience never resolvable). */
  async expire(): Promise<number> {
    const count = await this.deps.notificationsRepository.expireDue(STUCK_MS);
    if (count > 0) this.deps.logger.warn({ count }, 'notifications expired before delivery');
    return count;
  }

  /** retention job: delete history older than NOTIFICATION_RETENTION_DAYS, in small batches. */
  async purgeOld(): Promise<number> {
    const cutoff = new Date(Date.now() - this.deps.config.NOTIFICATION_RETENTION_DAYS * 86_400_000);
    let total = 0;
    for (;;) {
      const deleted = await this.deps.notificationsRepository.deleteBatchBefore(cutoff, 1000);
      total += deleted;
      if (deleted < 1000) return total;
    }
  }

  /** Sweep job: re-enqueue fan-outs whose job was lost or gave up. */
  async sweepFanouts(): Promise<number> {
    const ids = await this.deps.notificationsRepository.findStalledFanouts(STALL_MS, 100);
    for (const id of ids) await this.enqueueFanout(id);
    return ids.length;
  }

  /**
   * Inbox rows + pending deliveries for `userIds` (one transaction, ≤ one page). Users who already
   * have a row are skipped unless the notification is brand new.
   */
  private async materialize(
    tx: Tx,
    header: FanoutHeader,
    userIds: readonly string[],
    isNew: boolean,
  ): Promise<Dispatched> {
    const { notificationsRepository, preferencesService } = this.deps;
    const existing = isNew
      ? new Set<string>()
      : await notificationsRepository.existingRecipientIds(tx, header.id, userIds);
    const fresh = [...new Set(userIds)].filter((userId) => !existing.has(userId));
    const external = header.channels.filter((c): c is ExternalChannel => c !== 'IN_APP');
    const channelsByUser = await preferencesService.channelsFor(
      fresh,
      header.category,
      header.priority,
      external,
      tx,
    );
    const now = new Date();
    const recipients = fresh.map((userId) => ({ id: uuidv7(), userId }));
    const deliveries = recipients.flatMap((r) =>
      (channelsByUser.get(r.userId) ?? []).map((channel) => ({
        id: uuidv7(),
        recipientId: r.id,
        userId: r.userId,
        channel,
        priority: header.priority,
      })),
    );
    await notificationsRepository.insertRecipients(
      tx,
      recipients.map((r) => ({
        id: r.id,
        notificationId: header.id,
        userId: r.userId,
        app: header.app,
        category: header.category,
        expiresAt: header.expiresAt,
        createdAt: header.createdAt,
      })),
    );
    await notificationsRepository.insertDeliveries(
      tx,
      deliveries.map((d) => ({
        id: d.id,
        notificationId: header.id,
        recipientId: d.recipientId,
        userId: d.userId,
        channel: d.channel,
        priority: d.priority,
        nextAttemptAt: now,
      })),
    );
    if (recipients.length > 0)
      await notificationsRepository.advance(tx, header.id, { added: recipients.length });
    return {
      notificationId: header.id,
      app: header.app,
      createdAt: header.createdAt,
      item: {
        id: header.id,
        category: header.category,
        priority: header.priority,
        title: header.title,
        body: header.body,
        data: header.data,
        read: false,
        readAt: null,
        createdAt: header.createdAt,
      },
      recipients,
      deliveries: deliveries.map(({ id, userId, channel, priority }) => ({
        id,
        userId,
        channel,
        priority,
      })),
    };
  }

  /** Committed rows: live inbox push (SSE, best effort) + one queue job per delivery. */
  private dispatched(dispatched: Dispatched): void {
    this.deps.liveHub.publish({
      userIds: dispatched.recipients.map((r) => r.userId),
      app: dispatched.app,
      event: 'notification',
      data: dispatched.item,
    });
    if (dispatched.deliveries.length > 0)
      void Promise.resolve()
        .then(() =>
          this.deps.queues.enqueueDeliveries(
            dispatched.deliveries.map((d) => ({ ...d, attempts: 0 })),
          ),
        )
        .catch((err: unknown) => {
          this.deps.logger.warn({ err }, 'delivery enqueue failed; the sweep retries');
        });
    this.deps.logger.debug(
      {
        notificationId: dispatched.notificationId,
        recipients: dispatched.recipients.length,
        deliveries: dispatched.deliveries.length,
      },
      'notification dispatched',
    );
  }

  private async enqueueFanout(notificationId: string): Promise<void> {
    try {
      await this.deps.queues.enqueueFanout(notificationId);
    } catch (err) {
      this.deps.logger.warn({ err, notificationId }, 'fan-out enqueue failed; the sweep retries');
    }
  }
}
