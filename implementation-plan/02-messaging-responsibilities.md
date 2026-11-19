# 02 — Messaging Responsibilities: Redis vs RabbitMQ vs BullMQ

**Goal:** each tool has one job, so no two tools do the same thing.

## One-line rule

| Tool         | Job                                                   | Message meaning                                              |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------ |
| **RabbitMQ** | Durable **events between services**                   | "Something **happened**" (past tense: `user.registered`)     |
| **BullMQ**   | Background **jobs inside one service**                | "**Do** this, now or later" (imperative: `cleanup-sessions`) |
| **Redis**    | Fast **shared state** (cache, counters, flags, locks) | Not messaging at all                                         |

## Responsibility matrix

| Need                                                                  | Use                                        | Never use                               |
| --------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| Tell other services a fact (user registered, session compromised)     | RabbitMQ via **outbox**                    | BullMQ, Redis pub/sub                   |
| One event → many consumers (fan-out)                                  | RabbitMQ topic exchange `events`           | BullMQ                                  |
| Delayed or scheduled work (expire, retry later, cron)                 | BullMQ delayed or repeatable job           | RabbitMQ TTL tricks for business delays |
| Retry an external call with backoff (email, SMS, Razorpay API)        | BullMQ job                                 | RabbitMQ                                |
| Retrying a failed **event consumer**                                  | RabbitMQ retry queues (5s/30s/5m) → DLQ    | BullMQ                                  |
| Cache, rate-limit counters, idempotency keys, revocation flags, locks | Redis (`redis-cache`)                      | RabbitMQ                                |
| Live UI push across Socket.IO nodes (later)                           | Redis pub/sub (Socket.IO adapter **only**) | RabbitMQ for socket fan-out             |
| Sync request needing an answer now                                    | HTTP (internal REST)                       | RabbitMQ RPC                            |

## Hard rules

1. **BullMQ queues never cross a service boundary.** Only the service that owns a queue enqueues to it and processes it. Queue names are prefixed with the service and owning module: `auth.sessions-cleanup` (see [05](05-modular-monolith.md)).
2. **RabbitMQ is only for domain events**: no commands, no RPC, no delayed business tasks.
3. **Every RabbitMQ publish goes through the outbox**: the DB write and the outbox row are committed in one transaction, and the relay publishes afterwards. Nothing calls `channel.publish` directly from business code.
4. **Every RabbitMQ consumer is idempotent**: `ProcessedEvent(eventId)` is inserted in the same transaction as the handler's writes (inbox).
5. **Redis pub/sub is never used for domain events.** It drops messages when a subscriber is offline.
6. **Two Redis instances**, because their eviction policies conflict:
   - `redis-cache`: `maxmemory-policy allkeys-lru`, no persistence. Cache, rate limits, flags.
   - `redis-queue`: `maxmemory-policy noeviction`, AOF on. BullMQ only (BullMQ breaks if keys are evicted).
7. A consumer that needs slow work (sending an email, say) **acks the event after enqueuing a BullMQ job** in its own service. The event triggers the job; it doesn't do the work inline.

## Flow example (later, when notification-service exists)

```text
auth-service                         RabbitMQ                 notification-service
────────────                         ────────                 ────────────────────
POST /register
  tx: insert User + OutboxEvent ──►  (relay publishes)
                                     events ─ user.registered.v1 ─► queue notification.auth-events
                                                                     consumer (inbox check)
                                                                     → enqueue BullMQ "notification.send-email"
                                                                     → ack
                                                                   BullMQ worker sends the email,
                                                                   retrying with backoff
```

## Who uses what (current scope)

| Service      | Redis (cache)                                     | Redis (queue) / BullMQ                  | RabbitMQ                                                                                                                                                                              |
| ------------ | ------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api-gateway  | ✅ rate limits, `revoked:sid:*` check             | ❌                                      | ❌                                                                                                                                                                                    |
| auth-service | ✅ `revoked:sid:*` writes, login attempt counters | ✅ `auth.sessions-cleanup` (repeatable) | ✅ publishes via outbox: `user.registered.v1`, `user.status_changed.v1`, `user.deleted.v1`, `auth.session_compromised.v1` (see [docs/event-contracts.md](../docs/event-contracts.md)) |

## RabbitMQ topology

| Item                  | Name                                 | Type / settings                         |
| --------------------- | ------------------------------------ | --------------------------------------- |
| Main exchange         | `events`                             | topic, durable                          |
| Retry exchange        | `events.retry`                       | direct, durable                         |
| Dead-letter exchange  | `events.dlx`                         | direct, durable                         |
| Routing key format    | `<aggregate>.<event>.v<N>`           | e.g. `user.registered.v1`               |
| Consumer queue format | `<service>.<purpose>`                | quorum queue, `x-delivery-limit=5`      |
| Retry queues          | `<queue>.retry.5s` / `.30s` / `.5m`  | TTL, then dead-letters back to `events` |
| DLQ                   | `<queue>.dlq`                        | quorum queue, alert when non-empty      |
| Publisher             | confirm mode                         | via `amqp-connection-manager`           |
| Consumer              | prefetch 20, manual ack after commit |                                         |

## Event envelope (`packages/infra/src/events/envelope.ts`)

```ts
{ id: string /* uuid v7 */, type: string, version: number, occurredAt: string,
  source: string, correlationId: string, causationId?: string, data: T }
```

## Redis key namespaces (`packages/infra/src/redis/keys.ts`)

Keys below are shown without the root prefix; real keys are `farmx:<service>:v<N>:…`,
e.g. `farmx:auth:v1:revoked:sid:<sid>`.

| Key                                             | Owner                                          | TTL                       |
| ----------------------------------------------- | ---------------------------------------------- | ------------------------- |
| `gw:rl:<route>:<ip\|userId>`                    | api-gateway                                    | window                    |
| `auth:revoked:sid:<sid>`                        | auth-service writes, gateway reads             | access-token TTL (15 min) |
| `auth:login-fail:<email>`                       | auth-service                                   | 15 min                    |
| `auth:otp:<purpose>:<destHash>`                 | auth-service (live OTP, HMAC'd code, attempts) | 5 min, single use         |
| `auth:otp-cooldown:<purpose>:<destHash>`        | auth-service (resend cooldown)                 | 30–60 s                   |
| `auth:rl:<action>:<dest\|ip\|id\|user>:<value>` | auth-service (OTP send, login limits)          | window                    |
| `auth:rotation-grace:<sid>`                     | auth-service (refresh retry grace)             | ~10 s                     |
| `auth:perms:<userId>`                           | auth-service (effective permissions cache)     | until role change         |
| `idem:<service>:<key>`                          | each service                                   | 24 h                      |
| `bull:*`                                        | BullMQ on `redis-queue`                        | managed by BullMQ         |
