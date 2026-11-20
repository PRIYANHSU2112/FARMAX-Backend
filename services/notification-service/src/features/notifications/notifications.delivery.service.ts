import { randomInt } from 'node:crypto';

import type { Cradle } from '@fastify/awilix';

import type { SendResult } from '../../adapters/providers/index.js';
import { withTimeout } from '../../adapters/providers/index.js';
import type { DeliveryJob } from '../../adapters/queues.js';
import type { ClaimedDelivery, DeliveryRef } from './notifications.deliveries.repository.js';

type Deps = Pick<
  Cradle,
  | 'deliveriesRepository'
  | 'devicesService'
  | 'authDirectory'
  | 'providers'
  | 'queues'
  | 'metrics'
  | 'config'
  | 'logger'
>;

export type DeliveryOutcome =
  | { status: 'sent'; providerMessageId: string | null }
  | { status: 'retrying'; delayMs: number; error: string }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string }
  /** Not claimable: already done, or another worker holds it. */
  | { status: 'noop' };

/** Internal result of one send attempt (before retry accounting). */
type Attempt =
  | { kind: 'sent'; provider: string; providerMessageId: string | null }
  | { kind: 'retry'; provider: string | null; error: string }
  | { kind: 'failed'; provider: string | null; error: string }
  | { kind: 'skip'; reason: string };

const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 60 * 60_000;
/** A SENDING claim older than this is considered crashed (provider timeouts are ≤ 60 s). */
const LEASE_MS = 5 * 60_000;
/** PENDING / RETRYING overdue this long → its queue job was lost → re-enqueue. */
const OVERDUE_GRACE_MS = 60_000;

/** Exponential backoff with ±20 % jitter: 30 s, 1 m, 2 m, 4 m, 8 m … capped at 1 h. */
export const retryDelayMs = (
  attempt: number,
  jitter: () => number = () => randomInt(-200, 201) / 1000,
) => {
  const base = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_CAP_MS);
  return Math.round(base * (1 + jitter()));
};

/**
 * Sends ONE delivery attempt. At-least-once: the claim (PENDING/RETRYING → SENDING) is atomic, so
 * replicas never double-send in normal operation; a crash after the provider accepted but before
 * the result was stored can re-send once after the lease (providers / apps de-dupe by
 * notification id). A temporary provider failure never loses a notification: it is retried with
 * backoff until DELIVERY_MAX_ATTEMPTS, then FAILED (the delivery DLQ, retryable by an admin).
 */
export class DeliveryService {
  constructor(private readonly deps: Deps) {}

  async deliver(deliveryId: string): Promise<DeliveryOutcome> {
    const { deliveriesRepository: repo, metrics, config } = this.deps;
    const d = await repo.claim(deliveryId);
    if (d === null) return { status: 'noop' };

    let attempt: Attempt;
    try {
      attempt = await this.attempt(d);
    } catch (err) {
      // auth-service / DB hiccup while preparing: transient.
      this.deps.logger.warn({ err, deliveryId }, 'delivery attempt errored');
      attempt = { kind: 'retry', provider: null, error: (err as Error).message.slice(0, 200) };
    }

    switch (attempt.kind) {
      case 'sent':
        await repo.markSent(d.id, attempt.provider, attempt.providerMessageId);
        metrics.deliveries.inc({ channel: d.channel, status: 'sent' });
        metrics.deliveryLatency.observe(
          { channel: d.channel },
          (Date.now() - new Date(d.notificationCreatedAt).getTime()) / 1000,
        );
        return { status: 'sent', providerMessageId: attempt.providerMessageId };
      case 'skip':
        await repo.markSkipped(d.id, attempt.reason);
        metrics.deliveries.inc({ channel: d.channel, status: 'skipped' });
        return { status: 'skipped', reason: attempt.reason };
      case 'failed':
        await repo.markFailed(d.id, attempt.error, attempt.provider);
        metrics.deliveries.inc({ channel: d.channel, status: 'failed' });
        return { status: 'failed', error: attempt.error };
      case 'retry': {
        if (d.attempts >= config.DELIVERY_MAX_ATTEMPTS) {
          const error = `attempts exhausted: ${attempt.error}`;
          await repo.markFailed(d.id, error, attempt.provider);
          metrics.deliveries.inc({ channel: d.channel, status: 'failed' });
          return { status: 'failed', error };
        }
        const delayMs = retryDelayMs(d.attempts);
        await repo.markRetry(d.id, new Date(Date.now() + delayMs), attempt.error, attempt.provider);
        metrics.retries.inc({ channel: d.channel });
        metrics.deliveries.inc({ channel: d.channel, status: 'retrying' });
        await this.enqueue([{ ...ref(d), delayMs }]);
        return { status: 'retrying', delayMs, error: attempt.error };
      }
    }
  }

  /** Sweep job: lost jobs and crashed workers. Returns how many were re-enqueued. */
  async sweep(): Promise<number> {
    const { deliveriesRepository: repo } = this.deps;
    const stale = await repo.recoverStale(LEASE_MS, 500);
    const overdue = await repo.findOverdue(OVERDUE_GRACE_MS, 1000);
    const all = [...stale, ...overdue];
    await this.enqueue(all.map(ref));
    return all.length;
  }

  private async attempt(d: ClaimedDelivery): Promise<Attempt> {
    if (d.notificationStatus === 'CANCELLED') return { kind: 'skip', reason: 'CANCELLED' };
    if (d.expiresAt !== null && new Date(d.expiresAt) <= new Date())
      return { kind: 'skip', reason: 'EXPIRED' };
    switch (d.channel) {
      case 'PUSH':
        return this.push(d);
      case 'EMAIL':
        return this.email(d);
      case 'SMS':
        return this.sms(d);
    }
  }

  private async push(d: ClaimedDelivery): Promise<Attempt> {
    const { providers, devicesService, config, metrics } = this.deps;
    const provider = providers.push;
    const content = d.content.PUSH;
    if (provider === null) return { kind: 'skip', reason: 'PROVIDER_DISABLED' };
    if (content === undefined) return { kind: 'skip', reason: 'NO_CONTENT' };
    const tokens = await devicesService.pushTargets(d.userId, d.app);
    if (tokens.length === 0) return { kind: 'skip', reason: 'NO_DEVICE' };
    const started = Date.now();
    const result = await withTimeout(
      provider.send({ tokens, title: content.title, body: content.body, data: pushData(d) }),
      config.PROVIDER_TIMEOUT_MS + 2_000,
      () => ({
        sent: 0,
        providerMessageId: null,
        invalidTokenIds: [],
        retryable: true,
        error: { code: 'TIMEOUT', message: 'provider timed out' },
      }),
    );
    metrics.providerDuration.observe(
      { channel: 'PUSH', provider: provider.name, outcome: result.sent > 0 ? 'ok' : 'error' },
      (Date.now() - started) / 1000,
    );
    if (result.invalidTokenIds.length > 0) await devicesService.revokeDead(result.invalidTokenIds);
    if (result.sent > 0)
      return { kind: 'sent', provider: provider.name, providerMessageId: result.providerMessageId };
    const error =
      result.error === null
        ? 'no device accepted'
        : `${result.error.code}: ${result.error.message}`;
    if (result.retryable) return { kind: 'retry', provider: provider.name, error };
    if (result.invalidTokenIds.length === tokens.length)
      return { kind: 'skip', reason: 'NO_DEVICE' };
    return { kind: 'failed', provider: provider.name, error };
  }

  private async email(d: ClaimedDelivery): Promise<Attempt> {
    const provider = this.deps.providers.email;
    const content = d.content.EMAIL;
    if (provider === null) return { kind: 'skip', reason: 'PROVIDER_DISABLED' };
    if (content === undefined) return { kind: 'skip', reason: 'NO_CONTENT' };
    const contact = await this.deps.authDirectory.getContact(d.userId);
    if (contact?.status !== 'ACTIVE') return { kind: 'skip', reason: 'USER_INACTIVE' };
    // Only verified addresses: an unverified email may belong to someone else.
    if (contact.email === null || !contact.emailVerified)
      return { kind: 'skip', reason: 'NO_ADDRESS' };
    return this.timed('EMAIL', provider.name, () =>
      provider.send({ to: contact.email ?? '', ...content }),
    );
  }

  private async sms(d: ClaimedDelivery): Promise<Attempt> {
    const provider = this.deps.providers.sms;
    const content = d.content.SMS;
    if (provider === null) return { kind: 'skip', reason: 'PROVIDER_DISABLED' };
    if (content === undefined) return { kind: 'skip', reason: 'NO_CONTENT' };
    const contact = await this.deps.authDirectory.getContact(d.userId);
    if (contact?.status !== 'ACTIVE') return { kind: 'skip', reason: 'USER_INACTIVE' };
    if (contact.phone === null || !contact.phoneVerified)
      return { kind: 'skip', reason: 'NO_ADDRESS' };
    return this.timed('SMS', provider.name, () =>
      provider.send({ to: contact.phone ?? '', text: content.text }),
    );
  }

  private async timed(
    channel: 'EMAIL' | 'SMS',
    provider: string,
    send: () => Promise<SendResult>,
  ): Promise<Attempt> {
    const started = Date.now();
    const result = await withTimeout(send(), this.deps.config.PROVIDER_TIMEOUT_MS + 2_000, () => ({
      ok: false as const,
      retryable: true,
      code: 'TIMEOUT',
      message: 'provider timed out',
    }));
    this.deps.metrics.providerDuration.observe(
      { channel, provider, outcome: result.ok ? 'ok' : 'error' },
      (Date.now() - started) / 1000,
    );
    if (result.ok) return { kind: 'sent', provider, providerMessageId: result.providerMessageId };
    const error = `${result.code}: ${result.message}`;
    return result.retryable
      ? { kind: 'retry', provider, error }
      : { kind: 'failed', provider, error };
  }

  private async enqueue(jobs: DeliveryJob[]): Promise<void> {
    if (jobs.length === 0) return;
    try {
      await this.deps.queues.enqueueDeliveries(jobs);
    } catch (err) {
      this.deps.logger.warn(
        { err, count: jobs.length },
        'delivery enqueue failed; the sweep retries',
      );
    }
  }
}

const ref = (d: DeliveryRef | ClaimedDelivery): DeliveryJob => ({
  id: d.id,
  channel: d.channel,
  priority: d.priority,
  attempts: d.attempts,
});

/** FCM data payload: strings only; the app opens `entityType/entityId` and marks `notificationId` read. */
const pushData = (d: ClaimedDelivery): Record<string, string> => {
  const out: Record<string, string> = { notificationId: d.notificationId, app: d.app };
  for (const [key, value] of Object.entries(d.data))
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      out[key] = String(value);
  return out;
};
