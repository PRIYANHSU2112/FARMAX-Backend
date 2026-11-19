# 06 — One Shared Database (`@farmx/database`)

_Decided: 2026-11-04 (shared DB). Revised 2026-11-10 (database per service). Revised again
2026-11-11: back to **one shared database**, now owned by one package — see decision D-21._

## The rules

1. **One database for everything.** Postgres database `farmx` (created by `infra/docker/compose.yml`),
   one `DATABASE_URL` in the root `.env`, used by every service. Like one MongoDB cluster with all
   collections in it.
2. **Single source of truth.** The whole schema, every migration and the generated Prisma client live
   in `packages/database`. Services have no `prisma/` folder of their own.
3. **Safe pooling.** `getDatabase()` returns ONE client and ONE pg pool per process (singleton).
   Budget: Σ(processes × `DB_POOL_SIZE`) across all services < 80% of Postgres `max_connections`.
4. **Clean separation.** Only `*.repository.ts` (and `container.ts`) import `@farmx/database/client`
   — enforced by ESLint. Services, controllers and routes never touch the client.
5. **Ownership stays.** Each feature owns its models (`prisma/schema/<service>/<feature>.prisma`) and
   only its repository queries them. No Prisma relations across features; store the other id as a
   plain indexed column. Another service's data is read through that service (HTTP or events), not
   its tables.

```text
 services/auth-service ─┐                         packages/database
 services/<svc> ────────┼── getDatabase(DATABASE_URL) ──►  client.ts (singleton pool)
 scripts (seed) ────────┘                                   prisma/schema/{base,outbox}.prisma
                                                            prisma/schema/auth/*.prisma
                                                            prisma/schema/<svc>/*.prisma
                                   │
                                   ▼
                    Postgres database `farmx` (all tables)
```

## What `@farmx/database` exports

| Entry                    | For                              | Exports                                                                                                                                                      |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@farmx/database/client` | repositories, container, scripts | `getDatabase`, `closeDatabase`, `Database`, Prisma model types, `Prisma`                                                                                     |
| `@farmx/database`        | any layer                        | `Tx`, `RunInTransaction`, `createTransactionRunner`, `advisoryXactLock`, `withPrismaErrors`, `mapPrismaError`, `cursorArgs`, `toPage`, `createDbHealthCheck` |

## Adding tables for a feature

1. Add `packages/database/prisma/schema/<service>/<feature>.prisma`.
2. `pnpm db:migrate --name <change>` (creates and applies the migration, regenerates the client).
3. Write `<feature>.repository.ts` with `{ db }: Pick<Cradle, 'db'>`; pass `tx` to join a transaction.

## Commands

| Task                                  | Command                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| Start Postgres, Redis, RabbitMQ       | `pnpm infra:up`                                              |
| Stop (keep data) / wipe data          | `pnpm infra:down` / `pnpm infra:down -v`                     |
| Generate the client                   | `pnpm db:generate`                                           |
| Create + apply a migration (dev)      | `pnpm db:migrate` (add `--name <change>` for schema changes) |
| Apply migrations only (CI/prod)       | `pnpm db:deploy`                                             |
| Browse tables                         | `pnpm db:studio`                                             |
| Seed (permissions, first Super Admin) | `pnpm db:seed`                                               |
