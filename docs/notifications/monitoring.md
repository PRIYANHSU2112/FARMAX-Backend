# Notifications: monitoring and runbook

_For whoever runs FarmX in production._ notification-service exposes Prometheus metrics at
`GET /metrics` on its own port (3010). The gateway never routes it; scrape it on the internal
network. Prometheus / Grafana / Loki are not part of the repo yet; this is what to wire up.

## Scrape config

```yaml
scrape_configs:
  - job_name: farmx-notification-service
    metrics_path: /metrics
    scrape_interval: 15s
    static_configs:
      - targets: ['notification-service:3010'] # one target per replica
```

Every series carries `service="notification-service"`. Default Node.js process metrics
(`process_*`, `nodejs_*`: CPU, memory, event-loop lag, GC) are included.

## Metrics

| Metric                                   | Type      | Labels                                                          | Meaning                                                  |
| ---------------------------------------- | --------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| `notifications_created_total`            | counter   | `category`, `source` (event / admin)                            | Notifications created                                    |
| `notification_deliveries_total`          | counter   | `channel`, `status` (sent / retrying / failed / skipped)        | Outcome of each delivery attempt                         |
| `notification_delivery_latency_seconds`  | histogram | `channel`                                                       | Created → provider accepted                              |
| `notification_provider_duration_seconds` | histogram | `channel`, `provider`, `outcome`                                | Provider call time                                       |
| `notification_retries_total`             | counter   | `channel`                                                       | Attempts scheduled for retry                             |
| `notification_events_consumed_total`     | counter   | `type`, `result` (processed / duplicate / ignored / error)      | Business events handled                                  |
| `notification_queue_jobs`                | gauge     | `queue`, `state` (waiting / active / delayed / failed / paused) | BullMQ depth (read at scrape)                            |
| `notification_failed_deliveries`         | gauge     | `channel`                                                       | Deliveries in FAILED = the delivery DLQ (read at scrape) |
| `notification_sse_connections`           | gauge     | —                                                               | Open live streams on this replica                        |

Queues: `notification-push`, `notification-email`, `notification-sms` (deliveries),
`notification-jobs` (fan-out + housekeeping). The RabbitMQ DLQ
`notification-service.events.dlq` is visible in the RabbitMQ management UI (`:15672`) and its
Prometheus plugin (`rabbitmq_queue_messages{queue="notification-service.events.dlq"}`).

## Grafana panels

| Panel                     | Query                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Created / min by category | `sum by (category) (rate(notifications_created_total[5m])) * 60`                                                                                                   |
| Success rate by channel   | `sum by (channel) (rate(notification_deliveries_total{status="sent"}[15m])) / sum by (channel) (rate(notification_deliveries_total{status=~"sent\|failed"}[15m]))` |
| Delivery latency p95      | `histogram_quantile(0.95, sum by (le, channel) (rate(notification_delivery_latency_seconds_bucket[10m])))`                                                         |
| Provider time p95         | `histogram_quantile(0.95, sum by (le, channel, provider) (rate(notification_provider_duration_seconds_bucket[10m])))`                                              |
| Retries / min             | `sum by (channel) (rate(notification_retries_total[5m])) * 60`                                                                                                     |
| Queue depth               | `max by (queue) (notification_queue_jobs{state=~"waiting\|delayed"})`                                                                                              |
| Failed deliveries (DLQ)   | `max by (channel) (notification_failed_deliveries)`                                                                                                                |
| Event errors              | `sum by (type) (rate(notification_events_consumed_total{result="error"}[5m]))`                                                                                     |
| Live streams              | `sum(notification_sse_connections)`                                                                                                                                |

Queue and DLQ gauges are the same on every replica (they read shared state): use `max`, not `sum`.

## Alerts

| Alert            | Rule                                                                                     | Why                                     |
| ---------------- | ---------------------------------------------------------------------------------------- | --------------------------------------- |
| Push success low | success rate (above) `< 0.95` for 15 m, channel PUSH                                     | FCM credentials / quota / project issue |
| Email failing    | `rate(notification_deliveries_total{channel="EMAIL",status="failed"}[15m]) > 0` for 15 m | SMTP auth, sender domain, bounces       |
| Retries spiking  | retries / min `> 5×` the 1-day average                                                   | Provider degraded                       |
| Queue backlog    | `max(notification_queue_jobs{state="waiting"}) > 5000` for 10 m                          | Workers down or rate limit too low      |
| DLQ growing      | `delta(max(notification_failed_deliveries)[1h]) > 50`                                    | Persistent delivery failures            |
| Event errors     | event `error` rate `> 0` for 10 m, or RabbitMQ DLQ > 0                                   | Missing order projection, template bug  |
| Slow delivery    | p95 latency PUSH `> 60 s` for 15 m                                                       | Backlog / provider                      |

## Logs (Pino → Loki)

JSON logs with `service`, `requestId`, `notificationId`, `deliveryId`. Secrets, OTPs and tokens
are redacted by the shared logger; provider logs mask addresses (`r***@farm.in`, `******3210`) and
never include device tokens. Useful LogQL:

```
{service="notification-service"} |= "delivery attempt errored"
{service="notification-service"} | json | msg="event handling failed"
{service="notification-service"} |= "notifications expired before delivery"
```

## Runbook

| Symptom                                           | Check                                                                   | Fix                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| No pushes at all                                  | `PUSH_PROVIDER`, FCM credentials (log `FCM OAuth token request failed`) | Fix the service-account key; failed deliveries → bulk retry (`channel: PUSH`)                                     |
| Emails `FAILED` with `SMTP_5xx`                   | Sender domain (SPF / DKIM), credentials                                 | Fix, then `POST /v1/admin/notifications/deliveries/retry-failed` `{ channel: EMAIL }`                             |
| Deliveries stuck `RETRYING`                       | auth-service reachable? (`auth-service unavailable` in logs)            | They retry by themselves (≤ 1 h backoff)                                                                          |
| Events in `notification-service.events.dlq`       | Log reason (often `order projection missing`, or a template error)      | Fix the cause, then shovel the DLQ back to the queue (management UI → move messages); handling is idempotent      |
| Staff / broadcast notification stuck `PROCESSING` | auth-service internal routes, `INTERNAL_SERVICE_TOKEN`                  | The fan-out job retries with backoff and the sweep re-queues it; after 24 h without progress it becomes `EXPIRED` |
| Template change not visible                       | Template cache (60 s per replica)                                       | Wait a minute, or check the active version                                                                        |
| Badge out of date                                 | SSE is best effort                                                      | The app re-reads `unread-count` on reconnect / resume                                                             |
