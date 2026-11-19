# 03 — Phase 1: Foundation

**Stack:** TypeScript · pnpm · Turborepo · Fastify · Prisma · Awilix · Pino
**Scope:** monorepo tooling, the shared foundation packages, and both service skeletons booting.
**Out of scope:** real Postgres/Redis/RabbitMQ connections (Phase 2) and business features.

## Steps (in order)

### Step 1 — Monorepo and tooling

- [x] `.nvmrc` → `24`; `.npmrc` → `engine-strict=true`, `auto-install-peers=true`
- [x] Root `package.json`: `"private": true`, `"type": "module"`, `packageManager: pnpm@10.34.9`, `engines.node: ">=22.12"` (temporary, see 00)
- [x] `pnpm-workspace.yaml`: `packages/*`, `services/*`
- [x] `turbo.json` tasks: `build`, `dev`, `lint`, `typecheck`, `test`, `db:generate`, `clean`
- [x] `packages/tsconfig/base.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `module/moduleResolution: NodeNext`, `target: ES2023`
- [x] `packages/eslint-config` (flat config, `typescript-eslint` strict-type-checked, `import-x/no-cycle`, Prisma-only-in-repositories rule) and root `eslint.config.mjs`
- [x] Prettier, `.editorconfig`, `.gitignore`, `.prettierignore`, `.dockerignore`
- [x] Husky + lint-staged + commitlint (Conventional Commits; allowed scopes = workspace folder names + `root`, `infra`, `deps`, `plan`, `ci`, `release`)

**Done when:** `pnpm install`, `pnpm lint` and `pnpm typecheck` succeed on the empty workspace, and a bad commit message is rejected.
✅ **Verified 2026-11-04:** install, lint, typecheck, `eslint .` and `prettier --check` all clean; commitlint rejects a missing type and an unknown scope, and accepts `feat(auth-service): …`.

### Step 2 — Core shared packages (no infrastructure needed)

Build order: `types → errors → config → logger → response`.

- [x] **types:** `AuthUser`, `Role`, `Permission`, `Paginated<T>`, branded `UserId`/`SessionId`, `isRole()`
- [x] **errors:** `AppError` (code, statusCode, details, isOperational), HTTP subclasses, `ErrorCode` enum, `toAppError()`
- [x] **config:** `createConfig(schema)` merges the base Joi schema with the service schema, reports **all** errors at boot, and returns a frozen typed object; re-exports `Joi` so all services share one Joi instance
- [x] **logger:** `createLogger({ service, level, appEnv, version })` with Pino; redacts auth headers, cookies, and secret keys up to 3 levels deep; pino-pretty only when `APP_ENV=local`
- [x] **response:** `ok()`, `paginated()`, `fail()` envelope (`created()` dropped: the controller sets the 201 status); `fail()` hides the message of non-operational errors
- [x] Each package builds with tsup (ESM + `.d.ts`) and has Vitest unit tests
- [x] Shared versions live in the pnpm `catalog:` in `pnpm-workspace.yaml`

**Done when:** `pnpm build test` is green for all five packages.
✅ **Verified 2026-11-04:** `pnpm check` (lint, typecheck, test, build) is 20/20 green; 21 unit tests pass.

### Step 3 — Fastify kit (`middleware` + `server`)

- [x] **middleware:** `requestContextPlugin` (AsyncLocalStorage: requestId, userId; safe reuse of incoming `x-request-id`), `errorHandlerPlugin` (AppError / Joi / Fastify errors → envelope, plus 404 handler), `joiValidatorCompiler` (422 with `body.email`-style paths; strips unknown body fields, never headers), `securityPlugin` (helmet + CORS allowlist), `authenticate(verifier)` / `requireRoles()` / `authorize(permission, map)` (the JWT verifier is plugged in by auth-service later), `internalAuth(token)` (constant-time)
- [x] **server:** `buildService(options)` (no listen, for tests) and `startService(options)` register the standard plugins, `/health/live` and `/health/ready` (named checks, 2 s timeout each), OpenAPI 3.1 from Joi schemas (`joi-to-swagger`) + Swagger UI at `/docs`, and graceful shutdown (signal → readiness 503 → drain delay → `app.close()` → DI dispose → exit; forced exit after `SHUTDOWN_TIMEOUT_MS`)
- [x] **Awilix:** `@fastify/awilix` with the service's own container (`createContainer<Cradle>()`); per-request scope holds `requestId` and `log`; singletons with `.disposer()` / `asyncDispose` close on shutdown
- [x] ESLint: `require-await` off (Fastify's async-handler convention); `no-empty-function` off in tests

**Done when:** a test app built with `createService` answers `/health/live`, returns errors in the envelope format, and shuts down cleanly on SIGTERM.
✅ **Verified 2026-11-04:** `pnpm check` is 28/28 green; 24 new tests (17 server + 7 middleware) cover health/readiness, Joi 422s, error envelopes, request IDs, CORS, security headers, OpenAPI output, DI dispose, and the shutdown sequence (drain → close → exit 0, single run, forced exit 1 on hang). Real-signal shutdown is checked in Step 5 with the running services.

### Step 4 — Prisma foundation (`database` package + auth schema)

- [x] **database:** `createPrisma(factory, { logger, slowQueryMs })` (Prisma events → Pino; slow queries as warn; query params never logged), `mapPrismaError` / `withPrismaErrors` (P2002 → 409 with fields, P2025 → 404, P2003 → 400, P2034 → 409 retry, P1001/P1002/P1008/P1017/P2024 → 503), `isUniqueViolation(err, field)`, `cursorArgs` + `toPage` (keyset pagination, limit clamped to 1..100), `createDbHealthCheck`
- [x] **Prisma 7.10.1** (pinned; `latest` on npm is an 8.0 RC): `prisma.config.ts` + multi-file schema in `prisma/schema/` (one file per module: `base`, `auth`, `sessions`, `outbox`); `prisma-client` generator, ESM, output `src/generated/prisma`; models `User`, `Credential`, `Session`, `OutboxEvent`, `ProcessedEvent` (**no migration run yet**)
- [x] `services/auth-service/src/infra/prisma.ts`: client with the `@prisma/adapter-pg` driver adapter and pool size (proves `@farmx/database` types against the real generated client)
- [x] `db:generate` Turbo task runs `prisma generate` (inputs: `prisma/**/*.prisma`, `prisma.config.ts`)
- [x] Modular monolith adopted for every service ([05](05-modular-monolith.md)): `defineModule()` + `buildService({ modules })` in `@farmx/server`, `farmx/module-boundaries` ESLint rule, both service skeletons restructured into modules

**Done when:** `pnpm db:generate` produces a typed client and `typecheck` passes.
✅ **Verified 2026-11-04:** `prisma validate` OK; client generated (7.10.1); `pnpm check` is 36/36 green; 12 database tests + 3 module tests pass; the boundary rule caught all 4 planted violations (deep import, cross-service, shared → module, root → module internals).

### Step 5 — Service skeletons

- [x] **auth-service:** `config/` → `container.ts` → `routes/index.ts` (features) → `app.ts` → `server.ts`; health routes
- [x] **api-gateway:** `config/` → `container.ts` → `features/proxy/route-map.ts` → `app.ts` → `server.ts`; proxies `/v1/auth/*` → `AUTH_SERVICE_URL`
- [x] `dev` script per service: watch `src/server.ts`
- [ ] Root `pnpm dev` starts both services through Turbo

**Done when:** `pnpm dev` starts both services, `GET :3000/v1/auth/health/live` reaches auth-service through the gateway, and the logs are JSON with a matching `requestId`.

## Phase 1 definition of done

- [ ] Every step above is ticked
- [ ] `pnpm lint typecheck test build` is green from a clean clone
- [ ] Both services boot, log JSON with `requestId`, and shut down gracefully
- [ ] No service imports another service's code; shared code lives only in `packages/`
