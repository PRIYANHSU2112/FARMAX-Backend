# FarmX Backend — Implementation Plans

All implementation plans live in this folder. Read them in this order.

| #   | File                                                                 | What it covers                                                              | Status                         |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------ |
| 00  | [00-scope-and-decisions.md](00-scope-and-decisions.md)               | Current scope, fixed decisions, what is NOT built                           | ✅ Agreed                      |
| 01  | [01-folder-structure.md](01-folder-structure.md)                     | Full folder/file tree (root, packages, 2 services, infra)                   | ✅ Scaffolded (empty files)    |
| 02  | [02-messaging-responsibilities.md](02-messaging-responsibilities.md) | Redis vs RabbitMQ vs BullMQ — clear boundaries, no overlap                  | ✅ Agreed                      |
| 03  | [03-phase-1-foundation.md](03-phase-1-foundation.md)                 | TypeScript, pnpm, Turborepo, Fastify, Prisma, Awilix, Pino                  | ⏳ Next                        |
| 04  | [04-phase-2-infrastructure.md](04-phase-2-infrastructure.md)         | PostgreSQL, Redis, RabbitMQ, Docker Compose                                 | ⏳ After Phase 1               |
| 05  | [05-modular-monolith.md](05-modular-monolith.md)                     | Services with features inside: public APIs, boundary rules                  | ✅ Agreed (enforced by ESLint) |
| 06  | [06-single-shared-database.md](06-single-shared-database.md)         | One shared database, `@farmx/database` (schema, migrations, singleton pool) | ✅ Agreed                      |
| 07  | [07-farm-service.md](07-farm-service.md)                             | farm-service: models, journey, /v1/farms, /v1/admin/farms, events, phases   | 📝 Proposed                    |
| 08  | [08-catalog-service.md](08-catalog-service.md)                       | catalog-service: category tree (any depth), APIs, single gateway Swagger    | ✅ Built (categories)          |

Overview docs: [docs/architecture.md](../docs/architecture.md) ·
[docs/event-contracts.md](../docs/event-contracts.md) · [docs/decisions.md](../docs/decisions.md).

## Rules for this folder

- One plan per file, numbered `NN-topic.md`.
- When a step is done, tick its checkbox in the plan file.
- A new decision, or a change to an old one, goes into `00-scope-and-decisions.md` and
  [docs/decisions.md](../docs/decisions.md) with the date.
- Later plans (other services, NGINX, CI/CD, observability) get new files: `07-…`, `08-…`.
