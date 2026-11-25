import type { Cradle } from '@fastify/awilix';
import { type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import { emitWarehouseEvent } from './events.js';
import { uuidv7 } from './uuid.js';

export const JOBS_QUEUE = 'warehouse-jobs';
/** Dead-letter queue: jobs that failed every attempt (kept 14 days, replayable). */
export const DLQ_QUEUE = 'warehouse-jobs-dlq';

/** BullMQ connection options from a redis:// URL (BullMQ workers need maxRetriesPerRequest null). */
const queueConnection = (url: string): ConnectionOptions => {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username === '' ? {} : { username: decodeURIComponent(u.username) }),
    ...(u.password === '' ? {} : { password: decodeURIComponent(u.password) }),
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
};

/** Job name → schedule + heartbeat staleness limit (seconds). */
interface JobDef {
  every?: number;
  /** Cron in UTC (IST − 5:30). */
  pattern?: string;
  staleAfterSec: number;
}

const ATTEMPTS = 5;
const heartbeatKey = (job: string) => `warehouse:job:${job}:lastSuccess`;

/**
 * Repeating jobs (job scheduler: one run per tick across ALL replicas). Failure policy (D-57
 * §9): 5 attempts with exponential backoff (30 s base) → dead-letter queue (14 days, replay via
 * `/admin/wms/ops/jobs/dlq/:id/replay`) → `warehouse.job_failed.v1` alert. Each success writes a
 * heartbeat; `staleJobs()` reports jobs past their staleness limit (also alerted by `ops-watch`).
 *   refresh-stats     every STATS_REFRESH_SECONDS   inventory stock → warehouse_stock_* (D-56)
 *   cutover-watch     every 60 s                    auto-unfreeze a stock freeze past its deadline
 *   stock-expiry      daily 00:15 IST               available past expiry → EXPIRED; near-expiry
 *   stock-reconcile   daily 01:30 IST               WMS vs inventory totals, unit QR vs columns
 *   ops-watch         every 5 min                   stale heartbeats → alert
 *   D-57b fulfilment:
 *   facts-sync               every 30 s    order facts from order-service (outside the inbox tx)
 *   sla-watch                every 60 s    at-risk flag; critical exception past SLA + grace
 *   hold-auto-release        every 60 s    holds past autoReleaseAt
 *   hold-allocation-release  every 5 min   soft (held) lots past keepAllocationUntil (§2a.6)
 *   reallocation-recovery    every 60 s    saga retries / compensation (§2a.4)
 *   allocation-reconcile     every 10 min  WMS lines vs inventory reservations (§2a.3)
 *   daily-rollup             daily 00:40 IST  rebuild yesterday's counters
 *   compliance-escalation    every 15 min  overdue cases flagged / escalated / auto-rejected (§2a.7)
 *   ping-retention           daily 03:00 IST  next months' ping partitions; > 90 days dropped
 *   ping-downsample          daily 03:30 IST  pings older than 7 days → 1 per 5 min
 *   exports-run              every 30 s    queued exports (POD archive, delivered / fulfilled CSV)
 *   D-62 gate:
 *   gate-pii-retention       daily 02:30 IST  visitors / drivers anonymised; DL + RC scans deleted
 */
export class JobsRuntime {
  private queue: Queue | undefined;
  private dlq: Queue | undefined;
  private worker: Worker | undefined;
  private readonly alerted = new Set<string>();

  constructor(private readonly cradle: Cradle) {}

  defs(): Record<string, JobDef> {
    const statsEvery = this.cradle.config.STATS_REFRESH_SECONDS;
    return {
      'refresh-stats': { every: statsEvery * 1000, staleAfterSec: statsEvery * 5 },
      'cutover-watch': { every: 60_000, staleAfterSec: 300 },
      'stock-expiry': { pattern: '45 18 * * *', staleAfterSec: 26 * 3600 },
      'stock-reconcile': { pattern: '0 20 * * *', staleAfterSec: 26 * 3600 },
      'ops-watch': { every: 300_000, staleAfterSec: 1800 },
      'facts-sync': { every: 30_000, staleAfterSec: 600 },
      'sla-watch': { every: 60_000, staleAfterSec: 180 },
      'hold-auto-release': { every: 60_000, staleAfterSec: 600 },
      'hold-allocation-release': { every: 300_000, staleAfterSec: 1800 },
      'reallocation-recovery': { every: 60_000, staleAfterSec: 600 },
      'allocation-reconcile': { every: 600_000, staleAfterSec: 1800 },
      'daily-rollup': { pattern: '10 19 * * *', staleAfterSec: 26 * 3600 },
      'compliance-escalation': { every: 900_000, staleAfterSec: 3600 },
      'ping-retention': { pattern: '30 21 * * *', staleAfterSec: 26 * 3600 },
      'ping-downsample': { pattern: '0 22 * * *', staleAfterSec: 26 * 3600 },
      'exports-run': { every: 30_000, staleAfterSec: 600 },
      'routing-cap-watch': { every: 300_000, staleAfterSec: 1800 },
      'backorder-allocator': { every: 300_000, staleAfterSec: 900 },
      // D-60: per-warehouse tasks of quality decisions (release / quarantine / recall).
      'quality-tasks': { every: 30_000, staleAfterSec: 600 },
      // D-62: gate PII retention (visitors, drivers, DL / RC scans).
      'gate-pii-retention': { pattern: '0 21 * * *', staleAfterSec: 26 * 3600 },
    };
  }

  async start(): Promise<void> {
    const { config, logger } = this.cradle;
    const connection = queueConnection(config.REDIS_QUEUE_URL);
    this.queue = new Queue(JOBS_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 50,
        removeOnFail: 200,
      },
    });
    this.dlq = new Queue(DLQ_QUEUE, {
      connection,
      defaultJobOptions: {
        removeOnComplete: { age: 14 * 86_400 },
        removeOnFail: { age: 14 * 86_400 },
      },
    });
    for (const [name, def] of Object.entries(this.defs()))
      await this.queue.upsertJobScheduler(
        name,
        def.every !== undefined ? { every: def.every } : { pattern: def.pattern ?? '0 0 * * *' },
        { name },
      );
    this.worker = new Worker(JOBS_QUEUE, (job) => this.run(job.name), {
      connection,
      concurrency: 1,
    });
    this.worker.on('completed', (job) => {
      void this.cradle.redis
        .set(heartbeatKey(job.name), new Date().toISOString())
        .catch(() => undefined);
      this.alerted.delete(job.name);
    });
    this.worker.on('failed', (job, err) => {
      logger.error({ err, job: job?.name, attempt: job?.attemptsMade }, 'warehouse job failed');
      if (job !== undefined && job.attemptsMade >= ATTEMPTS) void this.deadLetter(job, err);
    });
  }

  async run(name: string): Promise<unknown> {
    const c = this.cradle;
    switch (name) {
      case 'refresh-stats':
        return c.statsService.refresh();
      case 'cutover-watch':
        return c.stockCutover.watch();
      case 'stock-expiry':
        return c.stockJobs.expire();
      case 'stock-reconcile':
        return c.stockJobs.reconcile();
      case 'ops-watch':
        return this.watchStale();
      case 'facts-sync':
        return c.fulfilmentSync.syncFacts();
      case 'sla-watch':
        return c.fulfilmentJobs.slaWatch();
      case 'hold-auto-release':
        return c.fulfilmentOrders.autoRelease();
      case 'hold-allocation-release':
        return c.fulfilmentOrders.expireSoftAllocations();
      case 'reallocation-recovery':
        return c.fulfilmentOrders.recoverReallocations();
      case 'allocation-reconcile':
        return c.fulfilmentJobs.reconcileAllocations();
      case 'daily-rollup':
        return c.fulfilmentJobs.rollup();
      case 'compliance-escalation':
        return c.complianceService.escalate();
      case 'ping-retention':
        return c.dispatchRepository.maintainPingPartitions();
      case 'ping-downsample':
        return c.dispatchRepository.downsamplePings();
      case 'exports-run':
        return c.fulfilmentDelivery.runExports();
      case 'routing-cap-watch':
        return c.routingService.capWatch();
      case 'backorder-allocator':
        return c.fulfilmentSplit.allocateBackorders();
      case 'quality-tasks':
        return c.stockQuality.runDue();
      case 'gate-pii-retention':
        return c.gateJobs.retention();
      default:
        c.logger.warn({ job: name }, 'unknown warehouse job');
        return undefined;
    }
  }

  /** Heartbeats + dead-letter count for `/admin/wms/ops/jobs`. */
  async status() {
    const now = Date.now();
    const out = [];
    for (const [name, def] of Object.entries(this.defs())) {
      const last = await this.cradle.redis.get(heartbeatKey(name)).catch(() => null);
      const age = last === null ? null : Math.round((now - Date.parse(last)) / 1000);
      out.push({
        job: name,
        schedule:
          def.every !== undefined
            ? `every ${def.every / 1000}s`
            : `cron ${def.pattern ?? ''} (UTC)`,
        lastSuccessAt: last,
        stale: age === null || age > def.staleAfterSec,
        staleAfterSec: def.staleAfterSec,
      });
    }
    const dead =
      this.dlq === undefined ? [] : await this.dlq.getJobs(['waiting', 'delayed', 'paused'], 0, 49);
    return {
      jobs: out,
      deadLetters: dead.map((j) => ({
        id: j.id,
        job: j.name,
        error: (j.data as { error?: string }).error ?? null,
        at: new Date(j.timestamp).toISOString(),
      })),
      deadLetterCount: this.dlq === undefined ? 0 : await this.dlq.count(),
    };
  }

  /** Re-queue a dead-lettered job (it runs once more with the normal retry policy). */
  async replay(dlqId: string): Promise<boolean> {
    const j = this.dlq === undefined ? undefined : await this.dlq.getJob(dlqId);
    if (j === undefined || this.queue === undefined) return false;
    await this.queue.add(j.name, {}, { jobId: `replay-${dlqId}-${Date.now()}` });
    await j.remove();
    return true;
  }

  private async deadLetter(job: Job, err: Error): Promise<void> {
    try {
      await this.dlq?.add(job.name, {
        error: err.message.slice(0, 500),
        attempts: job.attemptsMade,
        failedAt: new Date().toISOString(),
      });
      await this.alert(job.name, 'DEAD_LETTER', err.message, job.attemptsMade);
    } catch (e) {
      this.cradle.logger.error({ err: e }, 'could not dead-letter a warehouse job');
    }
  }

  private async watchStale(): Promise<number> {
    const { jobs } = await this.status();
    let n = 0;
    for (const j of jobs.filter((x) => x.stale && x.job !== 'ops-watch')) {
      if (this.alerted.has(j.job)) continue;
      this.alerted.add(j.job);
      await this.alert(j.job, 'STALE', null, 0, j.lastSuccessAt);
      n += 1;
    }
    return n;
  }

  private async alert(
    job: string,
    kind: 'DEAD_LETTER' | 'STALE',
    error: string | null,
    attempts: number,
    lastSuccessAt: string | null = null,
  ) {
    this.cradle.logger.error({ job, kind, error }, 'warehouse job alert');
    await this.cradle.runInTransaction((tx) =>
      emitWarehouseEvent(
        tx,
        'warehouse.job_failed.v1',
        { job, kind, error, attempts, lastSuccessAt },
        uuidv7(),
      ),
    );
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    await this.dlq?.close();
  }
}
