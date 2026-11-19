# 00 — Scope and Decisions

_Last updated: 2026-11-04_

## Current scope

- **Services in scope now:** `api-gateway`, `auth-service`. No other services yet.
- **Current work:** folder and file setup only. Files are empty placeholders; no implementation code yet.
- **Next:** Phase 1 (Foundation), then Phase 2 (Infrastructure).

## Fixed decisions

| Area           | Decision                                                                                                                                                           | Reason                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Runtime        | Node.js 24 LTS, TypeScript `strict`, ESM                                                                                                                           | Current LTS; strict mode catches bugs early                                     |
| Monorepo       | pnpm workspaces + Turborepo                                                                                                                                        | Fast installs, affected-only builds, `turbo prune` for Docker                   |
| HTTP framework | **Fastify**                                                                                                                                                        | Fast, plugin encapsulation, first-party swagger, rate-limit, helmet, http-proxy |
| DI             | **Awilix** (`@fastify/awilix`)                                                                                                                                     | No decorators or `reflect-metadata`; request-scoped containers                  |
| ORM            | **Prisma**, client generated into `src/generated/prisma`                                                                                                           | Type-safe; bundles cleanly into Docker images                                   |
| DB layout      | **One shared database `farmx`**, one `DATABASE_URL`; schema, migrations and a singleton pooled client in `@farmx/database`; see [06](06-single-shared-database.md) | One connection and one source of truth; ownership kept per feature (D-21)       |
| Logging        | **Pino** JSON to stdout, pino-pretty only locally                                                                                                                  | Fast, structured, ready for Loki later                                          |
| Validation     | Joi                                                                                                                                                                | Fixed by stack                                                                  |
| Package scope  | `@farmx/*`                                                                                                                                                         | Matches the product name                                                        |
| Messaging      | Redis, RabbitMQ and BullMQ, each with one job (see [02](02-messaging-responsibilities.md))                                                                         | No overlapping messaging                                                        |
| Orchestration  | **Docker Compose only. No Kubernetes.**                                                                                                                            | Too much ops overhead for a solo developer                                      |

## Version pins (2026-11-04)

| Tool        | Pinned                         | Why                                                                    |
| ----------- | ------------------------------ | ---------------------------------------------------------------------- |
| Node.js     | `.nvmrc` 24, `engines >=22.12` | This machine has 22.20; raise `engines` to `>=24` after upgrading Node |
| pnpm        | 10.34.9                        | Pinned via `packageManager`                                            |
| TypeScript  | `~6.0`                         | typescript-eslint supports `<6.1`; TS 7 (native) is not supported yet  |
| @types/node | `^24`                          | Matches the Node 24 target runtime                                     |
| lint-staged | `^16`                          | v17 requires Node ≥22.22.1; move to v17 after the Node upgrade         |

## Not built yet

- Kubernetes, Helm, Swarm, service mesh
- Kafka, Redis pub/sub for domain events, RabbitMQ delayed-message plugin
- The other services: user, catalog, order, payment, notification, search, realtime
- NGINX, CI/CD, the observability stack (each gets its own plan file later)
- CQRS, event sourcing, GraphQL

## Ports (current scope)

| Component                       | Port         | Public                  |
| ------------------------------- | ------------ | ----------------------- |
| api-gateway                     | 3000         | ✅ (later behind NGINX) |
| auth-service                    | 3001         | ❌ internal only        |
| postgres                        | 5432         | local only              |
|                                 |
| redis-cache                     | 6379         | local only              |
| redis-queue                     | 6380         | local only              |
| rabbitmq (AMQP / management UI) | 5672 / 15672 | local only              |
