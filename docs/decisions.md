# Decision Log

Every architecture decision is recorded here with its date, the reason for it, and what it costs.
A decision is never edited away. If it changes, add a new entry that **supersedes** the old one and
mark the old one. Details live in the linked plans.

| #    | Date       | Decision                                                                            | Status                              |
| ---- | ---------- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| D-01 | 2026-11-04 | Node 24 LTS, TypeScript strict, ESM                                                 | Active                              |
| D-02 | 2026-11-04 | pnpm workspaces + Turborepo                                                         | Active                              |
| D-03 | 2026-11-04 | Fastify · Awilix · Prisma · Joi · Pino                                              | Active                              |
| D-04 | 2026-11-04 | Docker Compose only, no Kubernetes                                                  | Active                              |
| D-05 | 2026-11-04 | Redis, RabbitMQ and BullMQ each get one job                                         | Active                              |
| D-06 | 2026-11-04 | Single shared database `farmx_db`                                                   | **Superseded by D-08**              |
| D-07 | 2026-11-10 | Microservices, modular inside                                                       | Active                              |
| D-08 | 2026-11-10 | One Postgres instance, one database per service                                     | **Superseded by D-21**              |
| D-09 | 2026-11-10 | Shared code in 3 packages: common, infra, tooling (source-only)                     | Amended by D-21 (+ database)        |
| D-10 | 2026-11-10 | Local Postgres in Docker only (Neon removed)                                        | Active                              |
| D-11 | 2026-11-10 | One `users` table for every persona                                                 | Active                              |
| D-12 | 2026-11-10 | Fixed permissions in code, dynamic roles in the DB                                  | Active                              |
| D-13 | 2026-11-10 | Short access tokens + rotating refresh tokens + Redis revocation                    | Active                              |
| D-14 | 2026-11-10 | OTPs and rate limits in Redis, not Postgres                                         | Active                              |
| D-15 | 2026-11-10 | Audit tables are append-only at DB level                                            | Active                              |
| D-16 | 2026-11-11 | `User` owned by the `users` module; no cross-module FKs                             | Active                              |
| D-17 | 2026-11-11 | One `admin_audit_log` owned by the `audit` module                                   | Active                              |
| D-18 | 2026-11-11 | Admin APIs fail closed; permission checks use GLOBAL scope only for now             | Active (temporary)                  |
| D-19 | 2026-11-11 | Per-service `.env` overrides the root `.env`                                        | **Superseded by D-21**              |
| D-20 | 2026-11-11 | Event contracts are producer-owned, versioned and secret-free                       | Active                              |
| D-21 | 2026-11-11 | One shared database in `@farmx/database`; `features/` service layout                | Active                              |
| D-22 | 2026-11-13 | Each service owning admin writes keeps its own append-only audit table              | Active                              |
| D-23 | 2026-11-13 | Non-auth services check permissions via auth's Redis cache + internal fallback      | Active                              |
| D-24 | 2026-11-13 | PAN app-encrypted + HMAC lookup; Aadhaar never stored                               | Active                              |
| D-25 | 2026-11-13 | Farm ID format, per-territory/type serial, immutable                                | Active                              |
| D-26 | 2026-11-13 | Territories and pin → node live in farm-service until logistics-service             | Active (interim)                    |
| D-27 | 2026-11-13 | `/internal/*` is never routed by the gateway                                        | Active                              |
| D-28 | 2026-11-14 | Category tree = adjacency list + materialized path, cached whole                    | Active                              |
| D-29 | 2026-11-14 | ONE Swagger UI for all services, merged at the gateway                              | Active                              |
| D-30 | 2026-11-14 | MFA is opt-in by default (`MFA_ENFORCED=false`)                                     | Active (revisit before prod)        |
| D-31 | 2026-11-17 | Promotions engine in order-service: integer-paise waterfall, event-fed projections  | Active                              |
| D-32 | 2026-11-19 | Cart: row lock + one-statement writes, guest token, version-bound checkout          | Active                              |
| D-33 | 2026-11-20 | inventory-service :3008: central warehouse × variant stock, DB-guarded reservations | Active (amended by D-36)            |
| D-34 | 2026-11-20 | Admin-confirmed orders; status separate from payment / stock / refund status        | Active (supersedes FR-ORD-01 names) |
| D-35 | 2026-11-20 | Prepaid before review: admin confirms only PAID + COMMITTED orders                  | Active                              |
| D-36 | 2026-11-20 | Reservation timing: ACTIVE (payment window) → COMMITTED → ISSUED at dispatch        | Active                              |
| D-37 | 2026-11-20 | payment-service :3009 (Razorpay + Mock providers) owns payments and refunds         | Active                              |
| D-38 | 2026-11-20 | Side effects via outbox events + BullMQ; never synchronous notifications            | Active                              |
| D-39 | 2026-11-20 | One shipment per warehouse; OTP-verified delivery; derived order delivery           | Planned (F1)                        |
| D-40 | 2026-11-20 | Delivery OTP policy: hashed + encrypted, TTL, attempt lock, resend cap              | Planned (F1)                        |
| D-41 | 2026-11-20 | New permissions `orders.confirm`, `orders.configure`                                | Active                              |
| D-42 | 2026-11-20 | Deferred: shipments, notification/invoice services, returns, wallet, NEFT           | Deferred                            |
| D-43 | 2026-11-20 | Unpaid by payment due time → order FAILED (distinct from CANCELLED / REJECTED)      | Active                              |
| D-44 | 2026-11-20 | Late / racing payments: recovery commit; terminal orders never revived → refund     | Active                              |
| D-45 | 2026-11-20 | Refund decision (order) and refund execution (payment) are separate lifecycles      | Active                              |

---

### D-01 · Node 24 LTS, TypeScript strict, ESM

Current LTS; strict mode catches bugs early. This machine runs 22.20, so `engines` stays `>=22.12`
until Node is upgraded. TypeScript is pinned to `~6.0` because typescript-eslint supports `<6.1`.
[00](../implementation-plan/00-scope-and-decisions.md)

### D-02 · pnpm workspaces + Turborepo

Fast installs and a version catalog in `pnpm-workspace.yaml`. Turbo runs affected-only tasks.
Shared packages are source-only, so Turbo uses a `transit` task for correct cache invalidation.

### D-03 · Fastify · Awilix · Prisma · Joi · Pino

- **Fastify:** plugin encapsulation and first-party plugins.
- **Awilix:** dependency injection without decorators.
- **Prisma 7:** driver adapter `@prisma/adapter-pg`; client generated into each service.
- **Joi:** validation, a fixed part of the stack.
- **Pino:** JSON logs to stdout.

### D-04 · Docker Compose only, no Kubernetes

One developer; Kubernetes is too much operational overhead. `infra/docker/compose.yml` runs locally
and `compose.prod.yml` overrides it for production. Services run on the host during development.

### D-05 · Redis, RabbitMQ and BullMQ each get one job

| Tool                                 | Job                                           |
| ------------------------------------ | --------------------------------------------- |
| RabbitMQ `events`                    | Cross-service facts, through outbox and inbox |
| BullMQ on `redis-queue` (noeviction) | Jobs owned by one service                     |
| `redis-cache` (LRU)                  | Flags, OTPs, rate limits, caches              |

Redis pub/sub is never used for domain events. [02](../implementation-plan/02-messaging-responsibilities.md)

### D-06 · Single shared database `farmx_db` — superseded by D-08

This gave simple joins, but it coupled the services' schemas and migrations.

### D-07 · Microservices, modular inside

Services deploy independently and talk only over internal HTTP or events. Inside a service, code is
split into modules that call each other only through `modules/<name>/index.ts`; the ESLint rule
`farmx/module-boundaries` enforces this. A module can later be extracted into its own service
without a rewrite. [05](../implementation-plan/05-modular-monolith.md)

### D-08 · One Postgres instance, one database per service — superseded by D-21

- **Why:** services stay autonomous and migrate independently, while running one instance keeps
  operating costs low.
- **How:** each service has its own Prisma client, schema and migrations, and never reads another
  service's tables. It uses HTTP or an event-fed read model instead.
- **Fallback:** if a hosting plan allows only one database, use one schema per service.

[06](../implementation-plan/06-single-shared-database.md)

### D-09 · Shared code in 3 packages: common, infra, tooling

The earlier 13 small packages were merged into `@farmx/common`, `@farmx/infra` and the tooling
packages.

- **No build step for shared packages:** their `exports` point at `.ts` files, and dev runs on tsx.
- **Services bundle them:** with tsup, keeping third-party dependencies external. Each service must
  therefore declare those dependencies itself; the tsup config computes the list.

### D-10 · Local Postgres in Docker only

Neon files and dependencies were removed so that dev, test and CI use the same Postgres 17 image.
Production hosting is decided later.

### D-11 · One `users` table for every persona

Staff, customers, vendors and logistics partners are all rows in `users`, distinguished by a
`userType` column. One login implementation; one person can hold several roles. Persona-specific
profiles, such as farm profiles, belong to future services.

### D-12 · Fixed permissions in code, dynamic roles in the DB

- **Permissions:** `access/permissions.catalog.ts` holds every permission key. The seed syncs it
  to the DB, and keys removed from code are marked deprecated.
- **Roles:** admins create roles at runtime. Only `super_admin` is seeded.
- **Super-admin-only keys:** keys such as `roles.assign` and `inventory.adjust` are marked
  `assignable=false`, so they can be held only by `super_admin`.
- **Why:** routes check stable keys, while the business can shape roles without a deploy.

### D-13 · Short access tokens, rotating refresh tokens, Redis revocation

- **Access tokens:** EdDSA JWTs that live 15 minutes and carry a session id (`sid`).
- **Refresh tokens:** opaque, stored only as SHA-256, and rotated on every use. Reusing an old one
  revokes its whole session family.
- **Revocation:** sets `revokedAt` in the DB and writes `revoked:sid:<id>` to Redis for 15 minutes.
  The gateway rejects flagged sessions immediately.
- **Status:** designed; only revocation is implemented so far.

### D-14 · OTPs and rate limits in Redis

- OTPs are short-lived and single-use, and are stored only as an HMAC.
- Per-destination and per-IP rate limits use fixed windows.
- If Redis is down, OTP send and verify fail closed with 503.
- The durable trail is `auth_events`. `credentials.lockedUntil` is the lockout backstop.

### D-15 · Audit tables are append-only at DB level

Triggers raise SQLSTATE 42501 on UPDATE, DELETE and TRUNCATE of `auth_events` and
`admin_audit_log`. `infra/docker/postgres/roles.sql` also revokes those rights from the app role.
Archival will run as the migrator role.

### D-16 · `User` owned by the `users` module; no cross-module FKs

`User` lives in `users.prisma`. The credential, MFA and device tables in the auth module reference it
by a plain indexed `userId`, with no foreign key and no cascade. That is acceptable because users are
only ever soft-deleted (`deletedAt`), and it keeps every module extractable.

### D-17 · One `admin_audit_log` owned by the `audit` module

`AdminAuditLog` (actor, action, target, before/after, reason, metadata, ip, requestId, time)
replaces `AccessAuditLog`. Every admin change writes it through `auditService.record(entry, tx)`, in
the same transaction as the change. Login and security events stay in `auth_events`.

### D-18 · Admin APIs fail closed; GLOBAL-scope checks for now (temporary)

- **Tokens:** until the tokens module verifies access tokens, the container's `tokenVerifier`
  rejects every token, so admin routes answer 401.
- **Scopes:** `requirePermission` counts only GLOBAL role assignments. Scoped checks (warehouse,
  region, vendor, own) come with the modules that own scoped resources.
- **Lockout guard:** the last active Super Admin can never be suspended, deleted or moved to
  another role.

### D-19 · Per-service `.env` overrides the root `.env` — superseded by D-21

- **Precedence:** shell variables first, then `services/<svc>/.env`, then the root `.env`. The
  `dev` scripts (repeated `--env-file-if-exists` flags) and `prisma.config.ts`
  (`process.loadEnvFile`) both follow this order.
- **Why:** each service keeps its own `DATABASE_URL` without clashing with the others.

### D-20 · Event contracts are producer-owned, versioned and secret-free

- **Ownership:** contracts live in `@farmx/infra/events/contracts/<producer>.events.ts`.
- **Versioning:** a breaking change becomes a new `.vN`.
- **Content:** no secrets, minimal personal data, and consumers must honour `user.deleted.v1`.
- **Dropped:** `user.password_reset_requested.v1`, because an OTP must never travel in an event.

[event-contracts.md](event-contracts.md)

### D-21 · One shared database in `@farmx/database`; `features/` service layout

- **Database:** one Postgres database `farmx` and one `DATABASE_URL` for every service, like one
  MongoDB cluster with all collections. The whole schema, all migrations and the generated client
  live in `packages/database` (single source of truth). `getDatabase()` gives one client and one
  pg pool per process (safe pooling).
- **Clean separation:** only repositories (and the DI container) may import
  `@farmx/database/client`; ESLint enforces it. Each feature still owns its models
  (`prisma/schema/<service>/<feature>.prisma`) and queries only those.
- **Layout:** every service uses `src/features/<feature>/` (routes, controller, service, repository,
  validation, types, module, index), `routes/index.ts`, `config/`, `server.ts` and
  `tests/unit` + `tests/integration`. Empty placeholders are not kept.
- **Kept:** PostgreSQL (not MySQL: triggers, arrays and partial indexes are in use), TypeScript and
  Fastify.
- **Cost:** services share one schema history, so a migration is reviewed for every service it
  touches; the database is a shared failure point.

[06](../implementation-plan/06-single-shared-database.md)

### D-22 · Per-service append-only audit table

`admin_audit_log` belongs to auth-service's audit feature, and features never query another
feature's tables. farm-service therefore keeps `farm_audit_log` with the same columns, written via
`auditService.record(tx, actor, entry)` in the same transaction as the change, append-only by the
D-15 trigger. **Cost:** a unified admin audit view needs a read model later.

### D-23 · Permission checks outside auth-service

A service reads auth's cached access summary (`perms:<userId>`, valid while its `v` equals
`rbac-version`) with one MGET. On a miss it calls auth `GET /internal/access/:userId/permissions`
(internal token), which refills the cache. Any failure denies. Unknown keys throw at route
registration. **Cost:** one extra hop on a cold cache.

### D-24 · PAN and Aadhaar storage

PAN: AES-256-GCM (`panCipher`, `panKeyId` for rotation), HMAC-SHA256 `panHash` for dedupe, and
`panMasked` for display. Aadhaar: only the last 4 digits, the provider reference and the result;
the number lives in request memory only and is redacted from logs.

### D-25 · Farm ID

`FX-{territory}-{type}-{serial:05}`. The type comes from the primary production type
(L, B, BB, LB, H, FM, R). The serial comes from `farm_id_sequences` (atomic upsert, row lock per
territory and type). The ID is issued only on activation and is immutable by trigger (42501); a
wrong ID is closed and replaced, never edited.

### D-26 · Geo masters in farm-service (interim)

`territories` and `pin_codes` (with node ids and names) live in farm-service until
logistics-service owns nodes; then they become an event-fed read model. Node ids in the seed are
fixed placeholders.

### D-27 · `/internal/*` never routed

The gateway refuses any path with an `internal` segment (404) before proxying, and farm-service is
proxied only under narrow prefixes. Internal routes also require `x-internal-token` and are
hidden from Swagger.

### D-28 · Category tree: adjacency list + materialized path

`categories.parentId` is the source of truth. `path` (`/<rootId>/…/<id>/`) and `depth` serve
subtree and ancestor reads in one query: `path LIKE '<prefix>%'` on a `text_pattern_ops` index.
A move rewrites the whole subtree in one `UPDATE` under a tree-wide advisory lock, after cycle and
depth checks. The live tree is cached whole (in-process for 30 s, then Redis for 10 min), so
storefront reads never hit Postgres and answer 304 on a matching ETag. Cost: admin writes are
serialized (they are rare). Depth limit: `CATALOG_MAX_CATEGORY_DEPTH`.

### D-29 · One Swagger for every service

Services publish only their OpenAPI spec (`/api-docs.json`, no UI). The api-gateway fetches all of
them in parallel (2 s timeout each), rewrites paths to public `/v1/...` paths, merges tags and
components, and serves one Swagger UI at `/api-docs` (+ `/api-docs.json`). The merged spec is
reused for 15 s, and a service that is down keeps its last good spec. Per-service docs URLs
(`/v1/*/api-docs*`) are refused at the gateway. A new service adds one entry to
`api-gateway/src/features/docs/docs.module.ts`.

### D-30 · MFA opt-in by default

Product decision (2026-11-14): users and admins turn MFA (TOTP) on from settings. Once it is on,
every login needs the code (`mfa_required` → `/auth/mfa/verify`). With `MFA_ENFORCED=false` (the
default), the `mfaRequired` flags on accounts and roles are ignored at login, and a user may turn
MFA off again. Set `MFA_ENFORCED=true` to restore mandatory enrolment for flagged accounts (e.g.
Super Admin). Cost: a staff account without MFA is protected by its password alone; turn
enforcement on before go-live.

### D-31 · Promotions engine in order-service

Offers and coupons live in order-service (`promotions`, `offers`, `pricing` features), next to the
future checkout that must re-check them in one transaction. The engine is pure and works in integer
paise / basis points: base price → line offers (BUNDLE_PAIR opt-in, else one of COMBO > PERCENTAGE >
FLAT per line) → one manual coupon → one auto bonus (stacks only when both are stackable, else the
bigger saving wins) → one freight benefit → GST per line on the discounted value (half-up per line,
HSN totals = sums of lines). Discounts are split pro-rata with the leftover paise on the largest
lines, so every line carries its exact share for GST and later refunds. Farm and variant data come
from event-fed projections (`farm.facts_changed.v1`, extended `VariantFactsV1`), never from
another feature's tables. Admin permissions reuse `pricing.view` / `pricing.manage` (the catalog's
"Pricing, discounts & promotions" module). Base price is the list price until pricing-service adds
tiers and membership. Cost: projections start empty — existing farms and variants appear only after
their next change event (a one-off republish is needed before go-live).

**Scope (2026-11-18):** order-service is Phase 1 only — the promotions engine. Cart comes next, then
Orders / Checkout (checkout re-checks usage limits under row locks and writes the redemptions).

### D-32 · Cart: row lock + one-statement writes, guest token, version-bound checkout

Cart lives in order-service (`carts`, `cart_items`, natural key `(cartId, variantId)`), one per
customer (`userId` unique, kept forever) or per guest (random UUID v4 `guestToken`, sent as
`X-Cart-Token`, 30-day sliding expiry). Every write is one short transaction: lock the cart row
(`SELECT … FOR UPDATE`), then ONE statement that reads the lines on a fresh snapshot, checks
min / max / known stock / line count, upserts and bumps `version`. There is no app-side
read-modify-write, so parallel taps add up and never pass a limit. "+" adds (`qty` increment);
the quantity box is absolute (idempotent) with an optional `expectedVersion` (409
CART_VERSION_CONFLICT). Login merge is one conditional statement (guest ACTIVE → MERGED), so it
runs exactly once; duplicates are summed and capped at the max order qty. Prices are never
trusted: the line snapshot only drives PRICE_CHANGED notices; GET re-reads the projections. Stock
is a soft check (inventory projection; unknown never blocks); the reservation belongs to order
placement. Checkout must lock the same cart row first and compare the quote's `cartVersion`
(`lockForCheckoutInTx` → 409 CART_CHANGED), then call `removeOrderedInTx` in the same
transaction. Lock order everywhere: cart → items → promotions.

### D-33 · inventory-service: central stock, DB-guarded reservations

inventory-service :3008 owns warehouses (+ PIN coverage, allocation priority), warehouse × variant
stock levels (onHand, reserved, damaged, safetyStock, reorderLevel), manual stock operations, an
append-only ledger, and reservations. PostgreSQL is the truth. Every reserve is a conditional
`UPDATE … WHERE onHand − reserved − safetyStock >= q` in lock order; CHECK constraints are the final
guard. Business settings live in `inventory_settings`. Not a WMS (no bins, picking, batches yet).
Plan: `~/.claude/plans/inventory-service-d33.md`. Amended by D-36.

### D-34 · Admin-confirmed orders; separate status columns

An order is created as `PENDING_ADMIN_CONFIRMATION`; staff confirm or reject it. `status` (business
lifecycle) is separate from `paymentStatus`, `stockStatus` and `refundStatus`, each changed only by its
own source. Every transition is one transaction under the order row lock and writes an append-only
`order_status_events` row. Supersedes the FR-ORD-01 state names; FR-ORD-08's tele-caller
confirmation queue is the admin review queue. Details: `docs/oms/`.

### D-35 · Prepaid before review

Customers pay at placement (BL-12). Confirm requires `paymentStatus=PAID` and `stockStatus=COMMITTED`
and no payment exception. Rejecting a paid order always creates a refund request.

### D-36 · Reservation timing (amends D-33)

Reserve ACTIVE at placement with TTL = `paymentWindowMinutes` (30) → COMMITTED (no expiry) on
`order.paid` → ISSUED (onHand −q) at dispatch (BL-07) → or RELEASED on reject/cancel/fail. A
10-minute hold cannot cover a manual review; reserving only at confirm would oversell paid orders.
Cost: committed stock waits for review — bounded by `adminAutoRejectHours` and a nightly orphan sweep.

### D-37 · payment-service

New service :3009, the only one that talks to Razorpay (plain `fetch` behind a `PaymentProvider`
interface; `MockProvider` for dev/test, refused when `APP_ENV=prod`). Owns payments, attempts,
signature verification (verify API + webhooks, raw-body HMAC, event-id dedup), refund execution and
reconciliation jobs. Order-service decides; payment-service executes.

### D-38 · Asynchronous side effects

Request paths do one transaction (checkout adds two idempotent internal calls) and return.
Notifications, invoices, refunds and analytics are outbox events consumed later; timers and retries
are BullMQ jobs. Future notification / invoice services only bind queues — no order or payment
code change.

### D-39 · Shipments (planned, F1)

On confirm, one shipment per warehouse; each runs ALLOCATED → PICKING → PACKED → DISPATCHED →
OUT_FOR_DELIVERY → DELIVERED independently. Order DELIVERED only when all active shipments are
delivered, PARTIALLY_DELIVERED otherwise. Delivery needs a verified OTP and a proof record.

### D-40 · Delivery OTP policy (planned, F1)

`crypto.randomInt`, length setting (default 6), HMAC-SHA256 with a pepper for verification plus an
AES-256-GCM copy for the owner's in-app view; TTL 12 h; lock after 5 attempts; resend cooldown 60 s,
max 3, each resend supersedes the previous OTP. Never logged, never in events (SMS via internal call).

### D-41 · New permissions

`orders.confirm` (confirm / reject / bulk; GLOBAL or REGION, sensitive) and `orders.configure`
(order settings; GLOBAL, sensitive). Existing `orders.*`, `payments.*`, `refunds.*` keys are reused.

### D-42 · Deferred

Shipments / OTP (F1), notification-service, invoice-service, returns, wallet, NEFT/RTGS, payment
links, recurring orders, quotations, settlements, e-invoice IRN.

### D-43 · Unpaid orders fail

Not paid by `paymentDueAt` + `paymentGraceSeconds` (after a live gateway check) → status FAILED
(`PAYMENT_NOT_COMPLETED`), paymentStatus EXPIRED, stock released, redemptions reversed. FAILED (system)
is distinct from CANCELLED (a person) and REJECTED (an admin).

### D-44 · Late and racing payments

A capture for a still-pending order whose hold expired triggers an inventory recovery commit; if
stock is gone the order FAILS with an automatic refund. A capture for a terminal order is recorded
but never revives it — it is refunded automatically. Recovery cases R1–R9: `docs/oms/03-state-machines.md`.

### D-45 · Two refund lifecycles

Order-service `OrderRefundRequest` (REQUESTED → ACCEPTED → COMPLETED / FAILED → RETRY_REQUESTED /
MANUALLY_RESOLVED) records the decision; payment-service `Refund` (CREATED → PROCESSING → PROCESSED /
RETRYING → FAILED_FINAL) executes it. Both keyed by a unique `sourceRef`, so retries never refund
twice. `paymentStatus` changes only on completion.

---

**Open questions:** how OTPs are delivered (auth-service sends them directly, or calls the
notification service), production Postgres hosting, and the Node 24 upgrade.
