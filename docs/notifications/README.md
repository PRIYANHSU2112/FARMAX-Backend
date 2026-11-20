# Notification Service

_notification-service :3010 · decision D-46 · built 2026-11-19._ One service delivers every FarmX
notification to every app: the **in-app inbox** (with live SSE updates), **push** (FCM),
**email** (SMTP) and **SMS**. Business services never call it: they publish events, and the
notification service decides who is told what, on which channels.

| Doc                                          | For                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| This file                                    | Architecture, event flow, consumed events, data model, templates, configuration |
| [integration-guide.md](integration-guide.md) | Customer app, admin panel, warehouse panel, logistics app developers            |
| [monitoring.md](monitoring.md)               | Metrics, alerts, dashboards, runbook                                            |

## Architecture

```mermaid
flowchart LR
  subgraph Producers
    O[order-service] & P[payment-service] & I[inventory-service]
  end
  O & P & I -- outbox → RabbitMQ events --> Q[(notification-service.events)]
  Q --> C[Consumer: inbox claim + rules + create<br/>ONE DB transaction]
  ADM[Staff: POST /v1/admin/notifications] --> C2[Admin send<br/>Idempotency-Key]
  C & C2 --> DB[(notifications · recipients · deliveries)]
  C & C2 -- after commit --> R[(Redis pub/sub)] --> SSE[SSE streams on every replica]
  C & C2 -- after commit --> BQ[(BullMQ<br/>notification-push / -email / -sms)]
  C -- staff / app audiences --> FO[fan-out job] -- auth-service internal --> DB
  BQ --> W[Delivery workers] --> FCM[FCM HTTP v1] & SMTP[SMTP] & SMS[SMS provider]
  W -- contact / tokens --> AUTH[auth-service /internal/users] & DT[(device tokens)]
```

- **One service, all channels.** Channels are adapters behind interfaces
  (`src/adapters/providers`): swapping SMTP for SES or adding an SMS gateway touches one file.
- **Shared infrastructure only:** the `farmx` database, `redis-cache` (SSE pub/sub, rate limits,
  auth caches), `redis-queue` (BullMQ), the RabbitMQ `events` exchange.
- **Never on a business request path.** Producers only write an outbox row; delivery is
  asynchronous. A provider outage delays notifications, it never fails an order or a payment.

### Features (`src/features`)

| Feature         | Owns                                  | Does                                                              |
| --------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `events`        | —                                     | Event → notification rules (`events.rules.ts`)                    |
| `notifications` | notifications, recipients, deliveries | Create (`accept`), fan-out, inbox API, delivery worker, admin API |
| `templates`     | notification_templates                | Rendering (+ 60 s cache), versioned admin management, preview     |
| `audience`      | notification_order_projections        | Order → buyer projection; audience resolution                     |
| `preferences`   | notification_preferences              | Delivery policy + user preferences API                            |
| `devices`       | notification_device_tokens            | FCM token registration                                            |
| `audit`         | notification_audit_log                | Append-only audit of every staff write                            |

## Delivery guarantees

**At-least-once, idempotent, never exactly-once.**

| Stage                | Mechanism                                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event → notification | Inbox row (`processed_events`) and the notification commit in one transaction; a redelivered event is a no-op. A **business dedupe key** (`order.confirmed:<orderId>`, `refund.processed:<refundId>` …) also absorbs re-sends with a new event id (order-service recovery-watch). |
| Admin send           | `Idempotency-Key` → dedupe key `admin:<staffId>:<key>`; a replay returns the first result.                                                                                                                                                                                        |
| Fan-out              | Staff / app-wide / > 500-user audiences: status `PROCESSING`, a BullMQ job resolves the audience page by page (`fanoutCursor`), under a row lock, skipping users already done. Retries with backoff; a sweep re-queues stalled fan-outs.                                          |
| Delivery             | One row per user × channel. A worker **claims** it atomically (`PENDING/RETRYING → SENDING`), so replicas never double-send. One BullMQ job per attempt (`delivery-<id>-<attempt>`).                                                                                              |
| Retry                | Transient errors (timeout, 5xx, 429, SMTP 4xx, auth-service down): backoff 30 s × 2ⁿ ± 20 %, capped at 1 h, up to `DELIVERY_MAX_ATTEMPTS` (6) → `FAILED`.                                                                                                                         |
| Dead letters         | Events: RabbitMQ `notification-service.events.dlq` (after 5 attempts). Deliveries: status `FAILED` (list + retry in the admin API).                                                                                                                                               |
| Crash recovery       | `delivery-sweep` (30 s): `SENDING` older than 5 min → `RETRYING`; overdue `PENDING/RETRYING` → re-enqueued. A crash after the provider accepted can re-send once; apps de-dupe by `notificationId`.                                                                               |
| Shutdown             | SIGTERM: consumer stops, workers finish running jobs, then queues, Redis and DB close.                                                                                                                                                                                            |

## Consumed events

Queue `notification-service.events` (binds only events that are **published today**).

| Event                         | Audience · app                                                     | Template                                        | Channels                 | Dedupe key                                      |
| ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- | ------------------------ | ----------------------------------------------- |
| `order.placed.v1`             | buyer · CUSTOMER (+ records order → buyer)                         | `order.placed`                                  | in-app, push             | `order.placed:<orderId>`                        |
| `payment.captured.v1`         | buyer                                                              | `payment.captured`                              | in-app, push, email      | `payment.captured:<paymentId>`                  |
| `payment.failed.v1`           | buyer                                                              | `payment.failed`                                | in-app, push             | `payment.failed:<paymentId>` (once per payment) |
| `order.confirmed.v1`          | buyer                                                              | `order.confirmed`                               | in-app, push, email      | `order.confirmed:<orderId>`                     |
| `order.rejected.v1`           | buyer · HIGH                                                       | `order.rejected`                                | in-app, push, email, SMS | `order.rejected:<orderId>`                      |
| `order.failed.v1`             | buyer · HIGH (`ORDER_CLOSED` re-sends: nobody)                     | `order.failed`                                  | in-app, push, email, SMS | `order.failed:<orderId>`                        |
| `order.cancelled.v1`          | buyer (FULL / PARTIAL)                                             | `order.cancelled` / `order.partially_cancelled` | in-app, push, email      | `<orderId>` / `<orderId>:<hash of lines>`       |
| `payment.refund_initiated.v1` | buyer                                                              | `refund.initiated`                              | in-app, push, email      | `refund.initiated:<refundId>`                   |
| `payment.refund_processed.v1` | buyer                                                              | `refund.processed`                              | in-app, push, email      | `refund.processed:<refundId>`                   |
| `payment.refund_failed.v1`    | staff with `refunds.approve` · ADMIN · HIGH                        | `refund.failed`                                 | in-app, push             | `refund.failed:<refundId>`                      |
| `order.review_overdue.v1`     | staff with `orders.confirm` · ADMIN · HIGH                         | `order.review_overdue`                          | in-app, push             | `order.review_overdue:<orderId>`                |
| `inventory.low_stock.v1`      | staff with `inventory.view` (GLOBAL or that warehouse) · WAREHOUSE | `inventory.low_stock`                           | in-app, push             | `inventory.low_stock:<eventId>`                 |

Only `order.placed.v1` carries the buyer, so buyer events are routed through
`notification_order_projections`. An event that arrives before its `order.placed` fails, is
retried (5×) and then dead-lettered (replay it from the DLQ).

### Needed from producers (not built: no fake events)

| Wanted                                                                                                        | Needs                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Welcome, account status, security alerts (`user.registered/status_changed.v1`, `auth.session_compromised.v1`) | auth-service has the contracts but **no outbox relay**; once it publishes, add rules (category ACCOUNT / SECURITY). |
| Password changed                                                                                              | A new `auth.password_changed.v1` contract (no secret in it). OTP codes never travel in events.                      |
| Shipments, pickup, delivery attempts / delivered, POD                                                         | Logistics service (F1) contracts.                                                                                   |
| WMS goods received, approval required / decided                                                               | WMS / inventory approval events.                                                                                    |
| Batch expiring                                                                                                | `inventory.batch_expiring.v1` exists as a type but is not emitted yet.                                              |

## Data model (`prisma/schema/notification`)

| Table                            | Notes                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notifications`                  | One per notification; content rendered once per channel (`content`); unique `dedupeKey`; status `SCHEDULED → PROCESSING → SENT` / `CANCELLED` / `EXPIRED`. Scheduling is a status, not a second table. |
| `notification_recipients`        | The inbox row (user × notification). Index `(userId, app, createdAt DESC, id DESC)` for paging; partial index on unread rows for the badge.                                                            |
| `notification_deliveries`        | User × external channel; status `PENDING → SENDING → SENT / RETRYING / FAILED / SKIPPED` with attempts, provider, last error (never an address). Partial indexes for due and in-flight rows.           |
| `notification_templates`         | Versioned per (key, channel, locale); one active version (partial unique index). 26 defaults seeded by the migration.                                                                                  |
| `notification_preferences`       | Explicit choices only (no row = default).                                                                                                                                                              |
| `notification_device_tokens`     | FCM tokens; unique token; ≤ 10 active per user.                                                                                                                                                        |
| `notification_order_projections` | order → buyer + order number.                                                                                                                                                                          |
| `notification_audit_log`         | Append-only (DB trigger).                                                                                                                                                                              |
| `processed_events`               | Shared inbox (consumer `notification-service.events`).                                                                                                                                                 |

**Personal data:** no email or phone is stored; workers ask auth-service
(`/internal/users/:id/contact`) at send time and only use **verified** addresses. Event payloads
and deep links hold ids only. **Retention:** notifications older than
`NOTIFICATION_RETENTION_DAYS` (180) are deleted daily with their recipients and deliveries; the
audit log is kept.

## Delivery policy

- In-app is always created. Each app has its own inbox (`app`), decided by the token's user type.
- Preferences per category × channel (push / email / SMS): opt-out by default, **PROMO is opt-in**.
- **SECURITY** category and **CRITICAL** priority ignore opt-outs (both are system-only: staff
  cannot send them).
- SMS only for HIGH / CRITICAL priority. Email / SMS only to verified addresses.
- Skips are recorded with a reason: `NO_DEVICE`, `NO_ADDRESS`, `USER_INACTIVE`, `EXPIRED`,
  `CANCELLED`, `PROVIDER_DISABLED`, `NO_CONTENT`.

## Templates

`{{name}}` placeholders only (no logic, single pass: a value is never expanded again). Variables
are declared per template with a type, so values are validated (422 per variable) and formatted:

| Type                                              | Example input          | Rendered                      |
| ------------------------------------------------- | ---------------------- | ----------------------------- |
| `string` (maxLength, control characters stripped) | `ORD-26-0091842`       | `ORD-26-0091842`              |
| `money` (rupees)                                  | `27821.5`              | `₹27,821.50`                  |
| `date` (ISO)                                      | `2026-11-30T04:30:00Z` | `30 Nov 2026, 10:00 am` (IST) |
| `number`                                          | `1234567`              | `12,34,567`                   |

Channel rules: PUSH falls back to the IN_APP template; email HTML escapes every value (default
HTML is generated from the text); SMS is one line ≤ 480 characters; push ≤ 100 / 240 characters.
Edit through `/v1/admin/notification-templates`: a new version keeps the variables (a different
set is a new key), can be saved as a draft, previewed, activated and rolled back.

Default keys: `order.placed`, `payment.captured`, `payment.failed`, `order.confirmed`,
`order.rejected`, `order.failed`, `order.cancelled`, `order.partially_cancelled`,
`refund.initiated`, `refund.processed`, `refund.failed`, `order.review_overdue`,
`inventory.low_stock`, `admin.message` (`title`, `body`).

## APIs

All under the gateway (`/v1`), documented in the one Swagger UI at `/api-docs`.

| Path                                                                                                                                         | Who                                     | What                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `GET /v1/notifications`, `/unread-count`, `/{id}`, `POST /{id}/read`, `/read-all`, `GET /stream`                                             | any signed-in user                      | Own inbox per app + SSE                  |
| `GET/PUT /v1/notifications/preferences`                                                                                                      | any signed-in user                      | Channel choices per category             |
| `GET/POST /v1/notifications/devices`, `DELETE /{id}`                                                                                         | any signed-in user                      | FCM tokens                               |
| `/v1/admin/notifications` (send, list, `{id}`, `{id}/cancel`, `deliveries`, `deliveries/{id}/retry`, `deliveries/retry-failed`, `analytics`) | staff: `notifications.view` / `.manage` | Send / schedule / cancel, DLQ, analytics |
| `/v1/admin/notification-templates` (list, `{id}`, create, `{id}/versions`, `{id}/activate`, `{id}/preview`)                                  | staff: `notifications.view` / `.manage` | Templates                                |

Not routed by the gateway: `/metrics` (Prometheus, service port) and nothing under `/internal`.
auth-service gained three internal routes for this service: `/internal/users/{id}/contact`,
`/internal/users/ids`, `/internal/access/recipients`.

## Configuration

Root `.env` (see `.env.example`, section _notification-service_).

| Variable                         | Default (non-prod / prod)       | Meaning                                                   |
| -------------------------------- | ------------------------------- | --------------------------------------------------------- |
| `NOTIFICATION_SERVICE_PORT`      | 3010                            |                                                           |
| `PUSH_PROVIDER`                  | console / fcm                   | `fcm` · `console` · `none` (console refused in prod)      |
| `FCM_SERVICE_ACCOUNT_JSON`       | —                               | Firebase service-account key, base64 (required for `fcm`) |
| `EMAIL_PROVIDER`                 | console / smtp                  | `smtp` · `console` · `none`                               |
| `SMTP_URL`, `EMAIL_FROM`         | — / `FarmX <no-reply@farmx.in>` | `smtp(s)://user:pass@host:port`                           |
| `SMS_PROVIDER`                   | console / none                  | `console` · `none` (real gateway: add an adapter)         |
| `PROVIDER_TIMEOUT_MS`            | 10000                           | Per provider call                                         |
| `DELIVERY_MAX_ATTEMPTS`          | 6                               | Then FAILED                                               |
| `PUSH/EMAIL/SMS_CONCURRENCY`     | 20 / 5 / 5                      | Parallel sends per replica                                |
| `PUSH/EMAIL/SMS_RATE_PER_SEC`    | 300 / 10 / 10                   | Global (all replicas)                                     |
| `FANOUT_CONCURRENCY`             | 4                               | Parallel fan-out jobs per replica                         |
| `NOTIFICATION_RETENTION_DAYS`    | 180                             |                                                           |
| `EVENTS_ENABLED`, `JOBS_ENABLED` | on (off in tests)               | Consumer / workers in this process                        |
| `METRICS_ENABLED`                | on                              | `/metrics`                                                |
| `INTERNAL_SERVICE_TOKEN`         | required in prod                | Calls to auth-service internal routes                     |

Adding a provider: implement `PushProvider` / `EmailProvider` / `SmsProvider`
(`src/adapters/providers/types.ts`): return `retryable: true` only for temporary failures, then
select it in `buildProviders` and add its config value.

## Tests

```
pnpm --filter @farmx/notification-service test                    # unit (+ app) tests
NOTIFICATION_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx \
  pnpm --filter @farmx/notification-service test                  # + Postgres / Redis / RabbitMQ
```

Integration tests use the local Docker infra (redis DB 8) with auth-service and the providers
faked; they cover redelivery and dedupe, out-of-order events, preferences, fan-out failure /
resume / parallelism, inbox isolation, SSE over real HTTP, retries / DLQ / crash recovery,
scheduling, retention, admin sends, templates and a real RabbitMQ round trip.
