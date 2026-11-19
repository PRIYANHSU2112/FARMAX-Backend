# 01 — Folder Structure

_Last updated: 2026-11-11 (shared `@farmx/database`, `features/` layout)._ Only folders and files that
exist are listed. Empty placeholders are not kept; add a file when its feature is built.

```text
backend/
├─ .env.example            # ONE DATABASE_URL for every service (+ Redis, RabbitMQ, ports, seed)
├─ package.json            # root scripts: infra:*, dev, build, test, lint, typecheck, db:*
├─ pnpm-workspace.yaml     # workspaces + dependency catalog
├─ turbo.json              # task graph (db:generate before typecheck/test/build)
├─ eslint.config.mjs  tsconfig.json  .prettierrc  commitlint/lint-staged configs
├─ docs/                   # architecture.md · event-contracts.md · decisions.md
├─ implementation-plan/    # numbered plans (this folder)
├─ infra/docker/
│  ├─ compose.yml          # postgres (database `farmx`), redis-cache, redis-queue, rabbitmq
│  ├─ compose.prod.yml     # production overrides: no published ports, secrets, restart
│  ├─ postgres/roles.sql   # farmx_app / farmx_migrator roles, audit-table REVOKEs
│  ├─ redis/redis-cache.conf · redis-queue.conf
│  └─ rabbitmq/rabbitmq.conf
├─ packages/
│  ├─ common/              # @farmx/common: config, logger, errors, response, types, middleware, server
│  ├─ database/            # @farmx/database — single source of truth for the database
│  │  ├─ prisma.config.ts
│  │  ├─ prisma/schema/    # base.prisma, outbox.prisma, <service>/<feature>.prisma (auth/…)
│  │  ├─ prisma/migrations/
│  │  └─ src/              # client.ts (getDatabase singleton pool) · transaction.ts · helpers/
│  ├─ infra/               # @farmx/infra: redis/ (clients, keys, lock) · events/ (envelope, contracts)
│  └─ tooling/
│     ├─ tsconfig/         # @farmx/tsconfig: base.json, node.json
│     └─ eslint-config/    # @farmx/eslint-config + rules/module-boundaries.js
└─ services/
   ├─ api-gateway/         # public entry, :3000
   ├─ auth-service/        # identity & access, :3001
   └─ _template/           # copy to create a service (never started or deployed)
```

## A service

```text
services/<service>/
├─ src/
│  ├─ features/<feature>/          # one business domain
│  │  ├─ <feature>.routes.ts       # endpoints + Joi schemas + guards
│  │  ├─ <feature>.controller.ts   # HTTP in/out, status codes, response envelope
│  │  ├─ <feature>.service.ts      # business rules (public API for other features)
│  │  ├─ <feature>.repository.ts   # the ONLY database access
│  │  ├─ <feature>.validation.ts   # Joi request schemas
│  │  ├─ <feature>.types.ts
│  │  ├─ <feature>.module.ts       # DI registration (Awilix) + route prefix
│  │  └─ index.ts                  # public API: what other features may import
│  ├─ routes/index.ts              # list of features to mount (health comes from @farmx/common)
│  ├─ config/index.ts              # env schema (gateway also: config/services.ts = upstream URLs)
│  ├─ middleware/                  # service-specific hooks only (e.g. require-auth.ts)
│  ├─ container.ts                 # config, logger, db (shared singleton), redis, runInTransaction
│  ├─ app.ts                       # builds the Fastify app, no listen (tests use it)
│  └─ server.ts                    # listen + graceful shutdown
├─ scripts/                        # only if needed (auth-service: seed.ts)
├─ tests/unit/ · tests/integration/
├─ .env.example  Dockerfile  package.json  tsconfig.json  tsup.config.ts  vitest.config.ts  README.md
```

auth-service features: `users`, `auth`, `access`, `sessions`, `audit` (tokens comes with login).
api-gateway features: `proxy`.

## Rules (ESLint)

- `farmx/module-boundaries`: features import each other only via `features/<name>/index.ts`;
  services never import each other.
- `no-restricted-imports`: only `*.repository.ts` and `container.ts` may import
  `@farmx/database/client` / `@prisma/*`. Everything else uses `@farmx/database` (helpers, `Tx` type).
