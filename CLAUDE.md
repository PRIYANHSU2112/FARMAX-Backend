# FarmX Backend — CLAUDE.md

## Project

- **FarmX**: a managed two-sided marketplace for poultry inputs and services (vaccines, vet pharma,
  feed additives, equipment, lab tests, vet consults) in the Godavari/Krishna belt of Andhra
  Pradesh, built to scale nationally.
- **Prepaid only.** No credit, no cash on delivery; drivers never collect money. The only credit is
  the buyer's own card.
- **Consignment sourcing** (sale-or-return, 6-month return rule): vendors are settled the **same
  working day** a sale is confirmed.
- **One published price**, non-negotiable: volume tiers → membership → offers, with a full price
  trace kept for every order line.
- **Traceability**: batch, expiry, COA and unit QR from receipt to the farm. FEFO picking. Cold
  chain at 2–8 °C.
- **Five surfaces, one domain core:** customer app (Android/iOS/web), vendor portal, warehouse
  portal/handheld, logistics (driver) app, admin console.
- **Network:** a mother warehouse plus C&F depots at Nuzvid, Tanuku and Anaparthy, held as
  configurable "nodes".
- **Sources:** `../Documents/` — Consolidated Requirements v3.0 (the baseline), Logistics PRD
  FXL/PRD/LOG/2026-03, admin-panel docs and design books.

## Roles (normative persona list)

- **Customers:** P1 commercial farmer · P2 hatchery · P3 feed mill · P4 B2C retail buyer · farm
  supervisor (delegate login).
- **Vendor:** P5 vendor admin · P5a vendor marketing · P6 vendor field rep.
- **FarmX internal:**
  - P7 category manager · P8 Super Admin (the only role that adjusts inventory, overrides prices,
    reverses settlements or changes permissions);
  - P9 warehouse manager · P10 depot in-charge · P12 field sales;
  - P13/P14 veterinarians · P15 support/tele-caller;
  - P16 finance · P17 quality/COA · P18 ad operations · P19 content reviewer.
- **Logistics:** P11 driver/partner. Logistics roles: DRV, 3PL, WHO, WHS, LOG, QA, QAM, FLT, CUS, ADM.
- **Admin RBAC:** dynamic roles built from a **fixed permission catalog**
  (`services/auth-service/src/features/access/permissions.catalog.ts`). Default deny; scopes are
  GLOBAL, WAREHOUSE, REGION, VENDOR or OWN.

## Modules (domain core)

- Identity & access · party/accounts (customers, farms with a Farm ID, vendors, KYC) · catalogue ·
  pricing & promotions · loyalty.
- Cart/checkout · orders · payments (Razorpay) & settlement (RazorpayX) · prescriptions & vet
  consults · COA & traceability.
- Procurement · warehouse (WMS) · inventory (batch, FEFO, quarantine) · logistics (consignments,
  driver app, POD) · cold chain · QMS.
- Ads · liquidation · leads (Book a Sales Call) · content/news · support tickets · notifications ·
  reports/audit · finance/GST.
- **Built today:** see `docs/PROGRESS.md` (auth, media, farm, catalog, product, user, order,
  inventory, payment, notification, call, wallet, support and warehouse services).

## Tech stack

- Node 22 (target 24) · TypeScript strict ESM · pnpm 10 workspaces + Turborepo.
- Fastify 5 · Awilix DI · Joi validation · Pino logs · Vitest.
- Prisma 7 + PostgreSQL 17. **One shared database `farmx`** and one `DATABASE_URL` through
  `@farmx/database`, which uses a singleton pool.
- Redis ×2: `redis-cache` (LRU: flags, OTP, rate limits) and `redis-queue` (BullMQ).
- RabbitMQ `events` exchange (outbox → inbox). Docker Compose only, no Kubernetes.
- OpenAPI 3.0.3 via `@fastify/swagger`. **ONE Swagger UI for all services** at gateway
  `/api-docs` (D-29); services only publish `/api-docs.json`. New service → add it to
  `api-gateway/src/features/docs/docs.module.ts`, `infra/docker/compose.stack.yml` (local) **and
  the PRODUCTION `docker-compose.yml`** (service block + `*_SERVICE_URL` in `x-env` + gateway
  `depends_on`). `api-gateway/tests/unit/compose.test.ts` fails until all are done.
- **Keep Docker files in sync:** any change to `infra/docker/compose.yml` (postgres, redis-cache,
  redis-queue, rabbitmq: image, version, ports, env, volumes, healthcheck, config files) or to
  `infra/docker/compose.stack.yml` is made in the **same task** in the root PRODUCTION
  `docker-compose.yml` (and `docker-compose.prod.yml` if it is affected). Never update one side
  only. Keep the intended differences: production binds no host ports for internal services and
  takes secrets from `.env`.

## Folder structure

```
packages/common     config, logger, errors, response envelope, middleware, server (buildService, docs)
packages/database   THE schema (prisma/schema/<service>/<feature>.prisma), migrations, getDatabase()
packages/infra      redis clients/keys, event envelope + contracts
packages/tooling    tsconfig, eslint-config (feature-boundary rule)
services/<svc>/src  features/<f>/{routes,controller,service,repository,validation,types,docs,module,index}.ts
                    routes/index.ts · config/ · middleware/ · container.ts · app.ts · server.ts
services/<svc>/tests/{unit,integration}     services/_template = copy for a new service
                    services: api-gateway :3000 · auth-service :3001 · media-service :3002 · farm-service :3003
                    · catalog-service :3004 · product-service :3005 · user-service :3006
                    · order-service :3007 · inventory-service :3008 · payment-service :3009
                    · notification-service :3010 · call-service :3011 · wallet-service :3012
                    · support-service :3013 · warehouse-service :3014 · quality-service :3015
infra/docker        compose.yml (+ compose.prod.yml)     docs/ · implementation-plan/
```

## Coding rules

**Architecture**

- A feature imports another feature **only through its `index.ts`** (ESLint enforces this).
  Services never import each other; they talk over HTTP or events.
- Only `*.repository.ts` and `container.ts` touch `@farmx/database/client`.
- A feature queries **only its own models**. No Prisma relations across features; store the
  other id as a plain indexed uuid column.
- One action is one transaction: `runInTransaction(tx => …)`, passing `tx` to other features'
  services. Redis and side effects run after commit.
- No empty placeholder files. Add a file only when its feature is built.

**Security**

- Every non-public route uses `requireAuth` plus `requirePermission('<module>.<action>')`.
  Authorization is enforced in the backend, never only in the UI.
- Sensitive actions need a reason, an audit row (`auditService.record`) and segregation of duties
  (approver ≠ requester). Audit tables are append-only (DB triggers).
- Never store card, bank or full Aadhaar data: gateway tokens and masked references only. Never
  log secrets, OTPs, tokens or passwords; Pino redacts them.
- Vendor data isolation is absolute, including through exports, search and error messages.
  External personas read **own records only**.
- Argon2id for passwords. OTP and rate-limit state live in Redis. Webhooks: verify the signature
  and process idempotently (`Idempotency-Key`).

**Validation and errors**

- Joi schemas live in `<feature>.validation.ts` and are attached to the route `schema`. Failures
  return 422 with `details.issues[{ path, message }]`.
- Success: `{ success: true, data, meta? }`. Error: `{ success: false, error: { code, message,
details?, requestId } }`.
- Throw the `AppError` subclasses from `@farmx/common/errors`; Prisma errors map through
  `withPrismaErrors`.

**Naming**

- Files: `<feature>.<layer>.ts`. DI keys: `usersService`, `usersRepository`.
- Permission keys: `module.action`. Events: `<aggregate>.<event>.v<N>`.
- Tables: snake_case plural via `@@map`. Columns: camelCase. Ids: UUID v7.
- Money: `Decimal(14,2)`. Pagination: cursor-based (`cursor`, `limit` ≤ 100).
- Swagger: each route has `<feature>.docs.ts` and spreads `routeDocs()` into its schema.
- Status changes run through explicit state machines, with every transition timestamped and
  attributed.

## Commands (from `backend/`)

```
pnpm install            pnpm infra:up / infra:down [-v]     pnpm dev   (gateway :3000, auth :3001)
pnpm docker:up          (LOCAL whole stack: infra/docker/compose.stack.yml, gateway :3000)
docker compose --env-file .env -f docker-compose.prod.yml up -d --build   (PRODUCTION server: all 15 services)
pnpm docker:down        pnpm docker:logs        pnpm docker:seed   (first run: permissions + super admin)
pnpm typecheck          pnpm lint        pnpm test        pnpm build        pnpm check (all)
pnpm db:generate        pnpm db:migrate [--name x]        pnpm db:deploy    pnpm db:seed    pnpm db:studio
pnpm --filter @farmx/auth-service keys:generate   (JWT keys, OTP_PEPPER, MFA_ENCRYPTION_KEY for .env)
```

API docs (all services, one page): `http://localhost:3000/api-docs` · spec: `http://localhost:3000/api-docs.json`.

## Docs

- `docs/PROJECT_CONTEXT.md`: features, flows, screen→API mapping, business rules, open questions.
- `docs/PROGRESS.md`: module checklist. **Update it after every task.**
- `docs/API_PLAN.md`: all planned APIs, DB models and relations.
- `docs/architecture.md` · `docs/decisions.md` · `docs/event-contracts.md` · `implementation-plan/`.
- `docs/notifications/`: notification-service (D-46): architecture, consumed events, app
  integration guide, monitoring.
- `docs/wallet/`: wallet-service (D-54): closed-loop wallet + reward points, app integration,
  guarantees, jobs, staff console, deploy checklist (`infra/sql/wallet-roles.sql`), runbook.
- Support (D-55, `docs/decisions.md`): support-service tickets + live chat; the ONE WebSocket layer
  is `@farmx/infra/realtime` (mount it for any future socket); Delete Account lives in auth-service.
- `docs/warehouse/`: warehouse portal (D-56): screen → API map for Login + Multi-Warehouse.
- `docs/oms/`: approved order-management + payment-service design (D-34…D-45; admin-confirmed
  orders, recovery playbook, refund lifecycles). Build order P1 inventory → P2 payment → P3 orders → P4 admin.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
