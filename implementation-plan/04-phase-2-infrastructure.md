# 04 — Phase 2: Infrastructure

**Stack:** PostgreSQL · Redis · RabbitMQ · Docker Compose (**no Kubernetes**)
**Scope:** local infrastructure in Docker, the `redis`/`events`/`queue` packages, and both services connected with real readiness checks.
**Prerequisite:** Phase 1 done.

## Containers (`infra/docker/compose.yml`; production overrides in `compose.prod.yml`)

| Service              | Image                                   | Port         | Volume       | Healthcheck                    |
| -------------------- | --------------------------------------- | ------------ | ------------ | ------------------------------ |
| postgres             | `postgres:17-alpine`                    | 5432         | `pgdata`     | `pg_isready`                   |
| redis-cache          | `redis:7.4-alpine` (`redis-cache.conf`) | 6379         | none         | `redis-cli ping`               |
| redis-queue          | `redis:7.4-alpine` (`redis-queue.conf`) | 6380         | `redisqueue` | `redis-cli ping`               |
| rabbitmq             | `rabbitmq:4-management-alpine`          | 5672 / 15672 | `rabbitdata` | `rabbitmq-diagnostics -q ping` |
| mailpit (local only) | `axllent/mailpit`                       | 1025 / 8025  | none         | none                           |

- **Networks:** `backend` (services ↔ infra). In dev/prod later the data network becomes `internal: true`.
- **One compose file locally:** `pnpm infra:up` = `docker compose -f infra/docker/compose.yml --env-file .env up -d --wait` (ports bound to 127.0.0.1). Production adds `-f compose.prod.yml`.
- Locally the services themselves run on the host with `tsx watch`; only infrastructure runs in Docker.

## Steps (in order)

### Step 1 — Docker Compose infrastructure

- [ ] `compose.yml` with the four infrastructure containers, named volumes and healthchecks
- [x] Port mappings live in `compose.yml` (127.0.0.1 only); `compose.prod.yml` removes them. Mailpit later.
- [ ] `postgres/init/01-databases.sql`: `CREATE ROLE auth_svc LOGIN PASSWORD …; CREATE DATABASE auth_db OWNER auth_svc;`
- [ ] `redis/redis-cache.conf`: `maxmemory 256mb`, `maxmemory-policy allkeys-lru`, `save ""`, `appendonly no`
- [ ] `redis/redis-queue.conf`: `maxmemory-policy noeviction`, `appendonly yes`
- [ ] `rabbitmq/definitions.json`: vhost `farmx`, user, exchanges `events` (topic), `events.retry`, `events.dlx` (direct)
- [x] Root scripts `infra:up`, `infra:down` (`infra:down -v` resets all data)

**Done when:** `pnpm infra:up` shows all containers healthy and the RabbitMQ UI at `:15672` lists the three exchanges.

### Step 2 — PostgreSQL + Prisma wiring (auth-service)

- [ ] `DATABASE_URL=postgresql://auth_svc:…@localhost:5432/auth_db?connection_limit=10`
- [ ] First migration: `prisma migrate dev --name init` (User, Credential, Session, OutboxEvent, ProcessedEvent)
- [ ] Extra SQL migration: partial index `outbox_unpublished_idx ON "OutboxEvent"("createdAt") WHERE "publishedAt" IS NULL`
- [ ] Indexes: `Session(userId)`, `Session(familyId)`, unique `Session(tokenHash)`, unique `User(email)`
- [ ] `dbHealth` wired into auth-service `/health/ready`

**Done when:** the migration applies cleanly and `/health/ready` returns 503 when Postgres is stopped and 200 when it is back.

### Step 3 — `redis` package

- [ ] `createRedis(url, { role: 'cache' | 'queue' })` with ioredis; `queue` role sets `maxRetriesPerRequest: null` (required by BullMQ)
- [ ] `cache.getOrSet(key, ttl, fn)` with TTL jitter and lock-based stampede protection
- [ ] `keys.ts` namespaces (see [02](02-messaging-responsibilities.md#redis-key-namespaces-packagesredissrckeysts)), `lock(key, ttlMs)` (`SET NX PX`), `redisHealth`
- [ ] Wired: gateway (`REDIS_CACHE_URL`) and auth-service (`REDIS_CACHE_URL`, `REDIS_QUEUE_URL`)

**Done when:** both services report Redis in `/health/ready`, and integration tests for cache and lock pass.

### Step 4 — `events` package (RabbitMQ)

- [ ] `connection.ts`: `amqp-connection-manager`, one connection per process, separate publish and consume channels
- [ ] `topology.ts`: asserts exchanges and, for each consumer, its queue, bindings, retry queues and DLQ (quorum, `x-delivery-limit=5`)
- [ ] `define-event.ts` + `registry.ts` + `contracts/auth.events.ts`: `user.registered.v1`, `user.password_reset_requested.v1`, `auth.session_compromised.v1` with Joi payload schemas
- [ ] `publisher.ts`: confirm mode, validates the payload against its contract before publishing
- [ ] `outbox.ts`: `outbox.write(tx, event)` and `createOutboxRelay(prisma, publisher)` (`FOR UPDATE SKIP LOCKED`, batch of 100, every 500 ms)
- [ ] `consumer.ts` + `inbox.ts`: `withInbox` dedupe, retry ladder 5s → 30s → 5m → DLQ, ack only after commit
- [ ] auth-service `worker.ts` runs the outbox relay

**Done when:** an integration test (Testcontainers) shows: outbox row → published → test consumer receives it once; a failing handler goes through 3 retries and lands in the DLQ; a redelivered duplicate is skipped.

### Step 5 — `queue` package (BullMQ)

- [ ] `createQueue(name)` / `createWorker(name, processor, opts)`, always on `redis-queue`
- [ ] Defaults: `attempts: 5`, exponential backoff starting at 2 s, `removeOnComplete: { age: 86400 }`, `removeOnFail: { age: 604800 }`
- [ ] Queue names must start with the owning service's prefix (checked at runtime)
- [ ] auth-service: repeatable job `auth.sessions-cleanup` (hourly) via a job scheduler, processor in `features/sessions/jobs/`
- [ ] Graceful shutdown closes workers before Redis

**Done when:** the cleanup job runs on its schedule, only one instance of it runs even with 2 worker processes, and SIGTERM waits for the active job to finish.

### Step 6 — Health, shutdown and env verification

- [ ] `/health/ready` per service: auth checks Postgres, redis-cache, redis-queue and RabbitMQ; the gateway checks redis-cache and auth-service reachability
- [ ] Shutdown order: readiness 503 → HTTP close → consumers cancel → BullMQ workers close → outbox relay stop → Prisma → Redis → AMQP
- [ ] `.env.example` complete for both services (table below)

**Done when:** killing any infrastructure container flips readiness to 503, recovery is automatic after a restart, and `docker compose down` during a running job loses nothing.

## Env vars (Phase 2)

| Var                   | Service | Local example                                                              |
| --------------------- | ------- | -------------------------------------------------------------------------- |
| `APP_ENV`             | both    | `local`                                                                    |
| `PORT`                | both    | `3000` / `3001`                                                            |
| `LOG_LEVEL`           | both    | `debug`                                                                    |
| `DATABASE_URL`        | auth    | `postgresql://auth_svc:auth_pw@localhost:5432/auth_db?connection_limit=10` |
| `REDIS_CACHE_URL`     | both    | `redis://localhost:6379/0`                                                 |
| `REDIS_QUEUE_URL`     | auth    | `redis://localhost:6380/0`                                                 |
| `RABBITMQ_URL`        | auth    | `amqp://farmx:farmx_pw@localhost:5672/farmx`                               |
| `AUTH_SERVICE_URL`    | gateway | `http://localhost:3001`                                                    |
| `SHUTDOWN_TIMEOUT_MS` | both    | `25000`                                                                    |

## Phase 2 definition of done

- [ ] `pnpm infra:up` starts healthy Postgres, two Redis instances, RabbitMQ and Mailpit
- [ ] auth-service is migrated and connected to everything; the gateway is connected to redis-cache
- [ ] Outbox → RabbitMQ → inbox, retry and DLQ are proven by integration tests
- [ ] The BullMQ repeatable job runs once per schedule across replicas
- [ ] Messaging boundaries in [02](02-messaging-responsibilities.md) hold: gateway has no AMQP or BullMQ, and no Redis pub/sub is used
