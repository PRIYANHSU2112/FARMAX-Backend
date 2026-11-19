# FarmX Backend Architecture

_Last updated: 2026-11-11._ This page describes what is built today and what is planned next.
Each "Not built yet" note says where the plan lives.

## System view

```mermaid
flowchart LR
  client["Clients<br/>admin panel · customer app<br/>vendor portal · logistics app"]

  subgraph edge["Public edge"]
    gw["api-gateway :3000<br/>proxy by path prefix<br/><i>planned: JWT verification (JWKS),<br/>revoked-session check, rate limits</i>"]
  end

  subgraph svc["Internal services"]
    auth["auth-service :3001<br/>features: users · auth · access ·<br/>sessions · audit · tokens (planned)"]
    more["future services<br/>(from services/_template)"]
  end

  subgraph data["Infrastructure (infra/docker/compose.yml)"]
    pg[("Postgres 17<br/>ONE shared database: farmx<br/>via @farmx/database")]
    rc[("redis-cache :6379<br/>allkeys-lru<br/>revoked sids · OTP · rate limits")]
    rq[("redis-queue :6380<br/>noeviction · AOF<br/>BullMQ jobs")]
    mq{{"RabbitMQ :5672<br/>topic exchange 'events'"}}
  end

  client -- "HTTPS /v1/*" --> gw
  gw -- "/v1/auth/* → /*<br/>internal HTTP" --> auth
  gw -. "/v1/&lt;svc&gt;/*" .-> more
  gw -. "reads revoked:sid:*" .-> rc

  auth -- "getDatabase() singleton pool" --> pg
  auth -- "writes revoked:sid:*" --> rc
  auth -. "BullMQ auth.sessions-cleanup" .-> rq
  auth -. "outbox relay → publish" .-> mq
  mq -. "consumer queues + inbox" .-> more
  more -. "same DATABASE_URL" .-> pg
```

Solid lines are built. Dotted lines are planned: outbox relay, consumers, BullMQ jobs, gateway auth.

## Building blocks

| Part              | Role                                                                                                                      | Code                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| api-gateway       | The only public service. Routes by path prefix and strips it (`/v1/auth/x` → auth-service `/x`).                          | `services/api-gateway`  |
| auth-service      | Identity and access: users, credentials, MFA, devices, RBAC, sessions, admin audit log.                                   | `services/auth-service` |
| `@farmx/common`   | Config, logger, errors, response envelope, middleware, `buildService()` / `defineModule()`.                               | `packages/common`       |
| `@farmx/database` | Single source of truth: the whole Prisma schema, migrations, the generated client, a singleton pooled client, DB helpers. | `packages/database`     |
| `@farmx/infra`    | Redis clients and keys, event envelope and contracts.                                                                     | `packages/infra`        |
| tooling           | Shared tsconfig and the ESLint config with feature-boundary rules.                                                        | `packages/tooling/*`    |
| `_template`       | Skeleton for new services. It is never deployed.                                                                          | `services/_template`    |

Shared packages hold infrastructure only, never business rules. They have no build step: each service
bundles them with tsup ([05](../implementation-plan/05-modular-monolith.md)).

## Inside a service (`src/features/<feature>/`)

```mermaid
flowchart TB
  routes["*.routes.ts<br/>schema (Joi) + preHandlers:<br/>requireAuth → requirePermission(key)"]
  ctrl["*.controller.ts<br/>HTTP → service call → envelope"]
  svcl["*.service.ts<br/>business rules · public API of the module"]
  repo["*.repository.ts<br/>the ONLY database access<br/>(@farmx/database/client)"]
  other["other feature's service<br/>(via its index.ts, injected by Awilix)"]
  db[("this feature's tables<br/>in the shared farmx DB")]

  routes --> ctrl --> svcl --> repo --> db
  svcl -- "runInTransaction(tx) → pass tx" --> other
```

- **Features** talk only through `features/<name>/index.ts`, which ESLint enforces. There are no Prisma
  relations or joins across features; cross-feature ids are plain indexed columns.
- **One action, one transaction.** For example, suspending a user updates `users`, revokes
  `sessions` and inserts into `admin_audit_log` in a single transaction. Redis side effects run
  after commit.
- **Default deny.** Every admin route needs a valid access token and a permission key from the
  fixed catalog (`access/permissions.catalog.ts`). Roles are dynamic data; permissions are code.

## Data ownership

| Service      | Database         | Tables (feature)                                                                                                                                                                                                                                                                        |
| ------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth-service | `farmx` (shared) | `users` (users); `credentials`, `password_history`, `mfa_factors`, `mfa_recovery_codes`, `user_devices`, `auth_events` (auth); `roles`, `permissions`, `role_permissions`, `user_roles` (access); `sessions` (sessions); `admin_audit_log` (audit); `outbox_events`, `processed_events` |

There is ONE shared database (`farmx`, one `DATABASE_URL`). The schema for every service lives in
`packages/database/prisma/schema/<service>/`; each feature still queries only its own tables
([06](../implementation-plan/06-single-shared-database.md)). `auth_events` and
`admin_audit_log` are append-only: DB triggers block UPDATE, DELETE and TRUNCATE.

## Messaging (one job each)

| Tool                  | Used for                                                            | Never used for              |
| --------------------- | ------------------------------------------------------------------- | --------------------------- |
| RabbitMQ `events`     | Facts between services (outbox → exchange → consumer queue → inbox) | Jobs inside one service     |
| BullMQ on redis-queue | Background jobs owned by one service module                         | Cross-service messages      |
| redis-cache           | Revoked-session flags, OTPs, rate limits, short caches              | Durable data, domain events |

Details: [02](../implementation-plan/02-messaging-responsibilities.md) and [event-contracts.md](event-contracts.md).

## Request lifecycle (admin example)

```mermaid
sequenceDiagram
  autonumber
  participant C as Admin panel
  participant G as api-gateway
  participant A as auth-service
  participant P as Postgres (farmx)
  participant R as redis-cache
  C->>G: PATCH /v1/auth/admin/users/:id/status (Bearer)
  G->>A: PATCH /admin/users/:id/status
  A->>A: requireAuth (token) → requirePermission('users.suspend') → Joi
  A->>P: BEGIN · lock · update users · revoke sessions · insert admin_audit_log · COMMIT
  A->>R: SET revoked:sid:{id} EX 900 (per revoked session)
  A-->>C: 200 { success, data }
  Note over G,R: Planned: the gateway rejects tokens whose sid is flagged
```

## Not built yet

- **Token verification and login.** The tokens and login flows (EdDSA JWT, JWKS, refresh rotation,
  OTP) are not built, so protected routes answer 401 until they are.
- **Gateway checks.** JWT checks, the revoked-sid check, rate limits and aggregated API docs.
- **Events and jobs.** The outbox relay, publisher, consumers, inbox and BullMQ jobs
  ([04](../implementation-plan/04-phase-2-infrastructure.md)).
- **Other services.** Catalog, order and payment services, plus NGINX, CI/CD and observability
  ([00](../implementation-plan/00-scope-and-decisions.md)).

## Running locally

```bash
cp .env.example .env          # DATABASE_URL → postgresql://farmx:farmx@localhost:5432/farmx
pnpm install
pnpm infra:up                 # Postgres, 2× Redis, RabbitMQ (Docker)
pnpm db:migrate && pnpm db:seed
pnpm dev                      # gateway :3000, auth-service :3001
```
