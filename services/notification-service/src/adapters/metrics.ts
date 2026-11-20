import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

type Collector = () => Promise<void>;

/**
 * Prometheus metrics of notification-service (`/metrics`, never routed by the gateway).
 * Gauges that need I/O (queue depth, failed deliveries) are filled by collectors registered by
 * the runtimes and run once per scrape, so nothing polls in the background.
 */
export class Metrics {
  readonly registry = new Registry();
  private readonly collectors: Collector[] = [];

  /** Notifications created, by category and source (event | admin). */
  readonly created = new Counter({
    name: 'notifications_created_total',
    help: 'Notifications created',
    labelNames: ['category', 'source'] as const,
    registers: [this.registry],
  });

  /** Final (or skip) outcome per delivery attempt: sent | retrying | failed | skipped. */
  readonly deliveries = new Counter({
    name: 'notification_deliveries_total',
    help: 'Delivery outcomes per channel',
    labelNames: ['channel', 'status'] as const,
    registers: [this.registry],
  });

  /** Created → provider accepted. */
  readonly deliveryLatency = new Histogram({
    name: 'notification_delivery_latency_seconds',
    help: 'Time from notification creation to provider acceptance',
    labelNames: ['channel'] as const,
    buckets: [0.25, 0.5, 1, 2, 5, 10, 30, 60, 300, 900],
    registers: [this.registry],
  });

  readonly providerDuration = new Histogram({
    name: 'notification_provider_duration_seconds',
    help: 'Provider call duration',
    labelNames: ['channel', 'provider', 'outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'notification_retries_total',
    help: 'Delivery attempts scheduled for retry',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  readonly eventsConsumed = new Counter({
    name: 'notification_events_consumed_total',
    help: 'Business events handled by the consumer',
    labelNames: ['type', 'result'] as const,
    registers: [this.registry],
  });

  readonly sseConnections = new Gauge({
    name: 'notification_sse_connections',
    help: 'Open SSE streams on this replica',
    registers: [this.registry],
  });

  /** BullMQ jobs per queue and state (waiting | active | delayed | failed). Filled per scrape. */
  readonly queueJobs = new Gauge({
    name: 'notification_queue_jobs',
    help: 'BullMQ jobs per queue and state',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });

  /** FAILED deliveries (the delivery DLQ) per channel. Filled per scrape. */
  readonly failedDeliveries = new Gauge({
    name: 'notification_failed_deliveries',
    help: 'Deliveries in FAILED (dead-letter) state',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  constructor(serviceName: string) {
    this.registry.setDefaultLabels({ service: serviceName });
    collectDefaultMetrics({ register: this.registry });
  }

  /** Registers an async gauge refresh that runs before each scrape. */
  onScrape(collector: Collector): void {
    this.collectors.push(collector);
  }

  /** Prometheus text format. A failing collector never breaks the scrape. */
  async render(): Promise<string> {
    await Promise.allSettled(this.collectors.map((collect) => collect()));
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
