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
| D-42 | 2026-11-20 | Deferred: shipments, notification/invoice services, returns, wallet, NEFT           | Deferred (wallet: superseded D-54)  |
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

### D-46 · Notification service

One notification-service (:3010) for every app and channel: in-app inbox (+ SSE live updates over
Redis pub/sub), push (FCM HTTP v1 called directly, no firebase-admin), email (SMTP) and SMS
(adapter; console until a DLT gateway is chosen). Producers never call it: it consumes published
events (outbox → RabbitMQ) and staff sends. At-least-once with idempotency: inbox + business dedupe
keys, `Idempotency-Key` for admin sends, atomic delivery claims, one BullMQ job per attempt,
backoff ≤ 1 h, FAILED deliveries as the DLQ. The consumer transaction does DB work only; audiences
that need auth-service (staff by permission / warehouse, whole apps) fan out in a background job.
Each app has its own inbox, chosen by the token's user type. No email / phone is stored: workers
fetch verified contacts from auth-service at send time. SECURITY / CRITICAL bypass opt-outs and
are system-only; PROMO is opt-in. Details: `docs/notifications/`.

### D-47 · Order money ledger

order-service keeps an immutable `order_transactions` ledger: one row per capture
(`payment.captured.v1`) and per refund (`payment.refund_processed.v1`), in integer paise, keyed
`capture:<paymentId>` / `refund:<refundId>` (unique), written in the same inbox transaction as the
event, before the lifecycle. Append-only (trigger), positive amounts (CHECK); totals are always sums,
so event order never matters. A 15-minute job reconciles settled rows per payment with
payment-service totals into `order_ledger_checks` (MISMATCH listed for finance, nothing
auto-corrected). payment-service stays the executor (D-37). Wallet / split tender is out of scope.

### D-48 · GST invoice core (order-service)

Tax documents (tax invoice, bill of supply, credit note) live in order-service (`tax_documents` +
`tax_document_lines`), issued **per shipment at dispatch** through
`ordersService.issueShipmentInvoiceInTx` (the F1 hook; nothing issues until F1 calls it). The
order's checkout snapshot is billed, never re-priced: each line's share for a shipment is
`round_half_up(amount × cumulativeQty / orderedQty)` minus the same for earlier shipments, so all
documents of an order add up to it exactly; freight is billed on the first invoice. Numbers
`<series>/<fy>/<7 digits>` (≤ 16 chars) come from `invoice_sequences` in the issuing transaction
(row-locked, gapless; lock order order row → sequence row). Idempotent per shipment
(`ship:<id>`); invalid data → 409 INVOICE_INVALID (dispatch blocked). A DB trigger makes issued
documents immutable except PDF / IRN / credit-status columns. E-invoice (IRN) fields exist but are
off (< ₹5 crore). GST assumptions awaiting business confirmation: docs/invoices (plan).

### D-49 · Product reviews & ratings (product-service `reviews` feature)

Reviews live in product-service (`product_reviews`, `review_eligibilities`, `review_votes`,
`review_reports`, `product_rating_summaries`). **Verified purchase only**: a customer may review a
product only after `order.delivered.v1` (contract defined ahead of its producer, F1 shipments/POD)
created an eligibility row, within `REVIEW_WINDOW_DAYS` (180). One live review per customer per
product (partial unique index); deleting frees the slot. Moderation is **auto-publish + flag**:
a rating or clean text publishes at once; images, links, phone, email, banned words, ALL-CAPS or
repeated characters → PENDING. `REVIEW_AUTO_HIDE_REPORTS` (3) open reports auto-hide a review until
an admin decides. Admin state machine approve / reject / hide / restore (reason for reject / hide,
`reviews.view` / `reviews.moderate`). Ratings count PUBLISHED reviews only and are kept as running
totals updated by **deltas** in the review transaction (atomic upsert), denormalised to
`products.ratingAvg` / `ratingCount` for cards, `sort=rating` and `minRating`. Author names are a
masked snapshot ("Ramesh K.") from auth-service. Events: `product.review_moderated.v1`,
`product.rating_changed.v1`.

---

### D-50 · Content & news (farm-service `content` feature)

News feed, disease alerts and the knowledge library live in farm-service (`content_*` tables), next
to the farm facts used for targeting (territory + production types of the reader's farm; empty
target list = everyone). Flock-stage / membership-tier targeting and the market-price card are
deferred; content is English only.

- **Alert accuracy:** ALERTs and `clinical` topics publish only with ≥ 1 cited source and a sign-off
  by a vet in the **verified reviewer register** (`content_reviewers`: Veterinary Council
  registration no., `validUntil`, verified by another admin). The sign-off is bound to a SHA-256 of
  the reader-visible fields: any edit voids it. The public byline comes from the register.
- **Separation of duties:** author (`content.manage`) → vet (`content.review`, new key) → a
  different approver (`content.publish`). Corrections of live items are two-person too
  (`content_revisions`, one PENDING per item, stale `baseVersion` → 409) and show a public
  "Updated" note. Taking content **down** (expire now, retract as wrong, archive) is a single,
  reasoned, audited action. Every transition → append-only `content_status_events` + audit row.
- **Expiry:** ALERT needs `expiresAt` ≤ 30 days (default 14); `content-tick` (BullMQ, 60 s) expires
  due alerts and publishes due SCHEDULED items; `extend` stays ≤ 30 days and needs a sign-off
  younger than 30 days. RETRACTED is final; readers then see only the withdrawal note.
- **Offline:** `POST /library/sync` takes the copies a device holds and answers KEEP / REPLACE
  (newer `contentVersion`) / DOWNLOAD / MARK_ENDED (expired: 7 days with a banner) / DELETE
  (retracted, archived, unsaved). Max 50 offline items; re-validate within 7 days.
- **Location privacy:** no API, event or notification carries farm / reader coordinates; distance
  is a bucket (`<5 km` … `50+ km`); alert areas are stored rounded to 2 decimals and shown to
  admins only.
- **Speed:** feed / search / detail cached per reader segment under a Redis generation counter
  (`INCR` on any visible change, no key scans); card queries select card columns only; views
  deduped per reader per day and buffered in Redis, flushed in one batched UPDATE; english FTS
  (generated weighted tsvector + GIN).
- **Push:** `content.published / corrected / retracted.v1` (no coordinates or ids of readers).
  notification-service resolves readers page by page from farm-service
  (`GET /internal/farms/content/:id/audience`, keyset on user id, segment ∪ savers) through the
  resumable fan-out; dedupe key `content.<kind>:<id>:v<contentVersion>`. New category `CONTENT`
  (opt-out); CRITICAL alerts are mandatory; routine (NORMAL) content pushes stop after 3 per user per
  24 h (inbox only).

### D-51 · Shop by Problem (diseases) + flock-stage filter (product-service)

- **Diseases are master data, not code:** `diseases` (name, slug, description, icon, sortOrder,
  isActive) + `product_diseases` junction, both in the `products` feature (the FK to `products` must
  stay inside one feature, like lookups). Admin CRUD `/v1/admin/catalog/diseases`
  (`catalogue.manage`, audited, If-Match versions).
- **Delete is soft only** and refused (409 `DISEASE_IN_USE`) while a live, active product is linked.
  Links to inactive / deleted products stay as history. Deleted diseases never show, never resolve
  by slug and cannot be newly linked; a product edit replaces only links to live diseases.
- **Slugs:** name and slug are unique among live rows only (partial unique indexes), so a deleted
  disease's slug can be reused. History references the disease id, never the slug.
- **Flock stages** are a new lookup group `FLOCK_STAGE` (admin-managed like species).
  `products.productionStages` keeps its `text[]` column but now holds FLOCK_STAGE codes, validated
  on write (live + active); GIN index for `hasSome`. Legacy free text is mapped by
  `pnpm --filter @farmx/product-service stages:map [-- --apply]` from code → label → `meta.aliases`
  (dry run first; unmapped values left as-is + CSV report; audit row per product).
- **Counts = storefront-visible products only** (the list's own `storefrontWhere`: published, active,
  live, active variant, visible category, active brand). Disease cards are cached 60 s under the
  product list version, which every product write, status change, disease write and lookup write
  bumps; a disease edit also drops linked product pages.

### D-52 · Storefront Filter & sort sheet (product-service + inventory node stock)

- **One selection, two endpoints:** `GET /v1/catalog/products` and `/products/filters` take the same
  filters (`resolve()` in the storefront builds one `StorefrontFilter` for both), so facet counts
  always match what a tap returns. The list adds `meta.total`; `/filters` adds `total` for the
  "Show X products" button.
- **Disjunctive facets:** species, diseases and brands are counted with every other filter applied
  but not their own (each facet's own dimension is dropped from the `where`). Selected values stay
  listed even at 0. Cached 60 s per normalised selection under the product list version.
- **Manufacturer = brand** (existing `brandId` filter); free-text `manufacturerName` is not faceted.
- **Disease chips are multi-select:** `diseaseId` / `diseaseSlug` are repeatable (matches any).
- **Sort `shelf_life`** = `Product.shelfLifeMonths` desc, unknown last (batch expiry is not used).
- **"In stock at <node>":** nodes are inventory warehouses (`farm.primaryNodeId`).
  `inventory.availability_changed.v1` gains an optional `byNode` (full per-node set, allocatable
  only). It is additive, so it stays v1. inventory-service dedups on a `nodeStockKey` ("nodeId:qty,…"),
  so a depot-to-depot transfer re-publishes. product-service keeps `variant_node_availability`,
  which is replaced per variant under the same `sequence` guard. Filter = `inStock=true&nodeId=…`;
  `nodeId` alone does nothing. The app reads the node name from `GET /v1/farms/geo/pincodes/:pin`
  and hides the toggle when the farm has no node.
- **"Covered by my prescriptions" is deferred** until an Rx service exists; `/filters` returns
  `rx.available=false` so the app shows the toggle disabled.
- **Compliance:** filters only narrow `storefrontWhere`; sponsored placements never go through it.

### D-53 · Book a Sales Call → call-service (:3011)

- **Own service** `call-service` (Figma C-12a/d/e). Plan: experts → pooled availability → hold →
  confirm → call journey; leads scored SQL / MQL / ENQUIRY.
- **Hold and booking are one row** (`call_bookings`). Double booking is impossible because of a
  gist `EXCLUDE (expertId =, tsrange(blockedStartAt, blockedEndAt) &&)` over HELD / CONFIRMED /
  ACKNOWLEDGED / IN_PROGRESS.
  - The blocked range includes **per-channel buffers**, snapshotted on the row.
  - Inserts use `ON CONFLICT DO NOTHING` and try the next rep.
  - Stale holds are expired inside the hold transaction, because the constraint cannot use `now()`.
- **No network calls inside transactions.** Farm ownership and the versioned price quote are fetched
  first. Confirm re-quotes and returns 409 `PRICE_CHANGED` when the version moved. After confirm, the
  price and quantity are frozen by a trigger; snapshots change only on erase.
- **Recommended-expert card ≠ assignment** (`RECOMMENDATION_ONLY`). VET profiles are never bookable
  (DB CHECK), because leads never touch Rx.
- **Three separate append-only consents:** ROUTING, SHARE_WITH_BRAND, RECORDING. Withdrawing share
  consent reassigns the call away from a vendor rep. Erase redacts PII and keeps non-PII facts.
- **NO_ANSWER** is an attempt result. **NO_SHOW** (customer) and **MISSED** (rep / system) are final
  and can be rescheduled.
- **Every rule is data** (`call_settings`) and every chip is a row (`call_options`). Telephony is
  mock-only until a vendor is chosen, and production refuses to boot without one.
- **Permissions:** reuse `sales.view` / `sales.manage` and add `sales.configure`. Customers and
  experts are authorised by identity (own records; an active `experts` row).

### D-54 · Wallet & Rewards → wallet-service (:3012) (supersedes the wallet part of D-42)

- **Own service** `wallet-service` (Figma: Points & wallet, Add money, Wallet statement, Points
  ledger, Transaction history). It is the ONLY writer of the wallet ledger. Plan:
  `~/.claude/plans/pasted-content-id-4f6a-deeply-analyze-serene-squirrel.md`, phases W1–W6.
- **Closed-loop wallet:** money can only be spent on FarmX orders. No transfer, withdrawal or P2P
  (keeps it outside RBI PPI licensing). Checkout is paid by **wallet only OR gateway only** (no
  split tender). Points earn only on `order.delivered.v1` (F1).
- **Double-entry, append-only ledger in PostgreSQL** (integer paise; Redis never holds balances):
  - every `wallet_journals` row has ≥ 2 `wallet_postings` summing to 0 (deferred constraint trigger);
  - journals / postings / accounts cannot be updated or deleted (triggers); corrections are
    REVERSAL journals;
  - a USER balance changes only through one conditional `UPDATE … WHERE balance + Δ ≥ 0 AND
status = 'ACTIVE'` (credits always land, even when FROZEN), and the posting chain trigger
    requires `balanceAfter = previous + amount = account balance`; a deferred trigger rejects any
    balance change without a matching posting;
  - SYSTEM accounts (GATEWAY_CLEARING, ORDER_SETTLEMENT, REWARDS_EXPENSE, ADJUSTMENT) carry no
    running balance (derived from postings), so no hot row exists.
- **Idempotency in the database:** `wallet_journals.idempotencyKey` is unique and claimed with
  `INSERT … ON CONFLICT DO NOTHING` first; a concurrent duplicate waits, then replays the winner.
  The same key for a different movement → 409 `IDEMPOTENCY_KEY_REUSED`.
- **Fast failure under contention:** wallet transactions run with `lock_timeout = 3 s`; a lock or
  pool timeout → 503 `WALLET_BUSY` (retry with the same key is always safe).
- **Top-ups reuse payment-service (W2):** `Payment.purpose` = ORDER | WALLET_TOPUP (CHECK: an
  order payment has orderId / orderNo, a top-up payment has `referenceId` = top-up id). Top-up
  outcomes go out only as `payment.topup_*.v1`, so order consumers never see them, and an order
  refund can never touch a top-up payment. The wallet is credited with the **captured** amount once
  (ledger key `topup:<id>`), even after the top-up expired; event, live check and reconcile job all
  funnel into one locked `applyInTx`.
- **Wallet checkout (W3):** payment-service provider `WALLET` debits the whole order through
  wallet-service (`pay:<paymentId>`) and then runs the normal capture path, so the order lifecycle,
  late-payment refunds and the order ledger are unchanged. Refunds of a WALLET payment are wallet
  credits (`refund:<refundId>`, serialised per payment, never above the debit). order-service only
  stores `paymentMethod` and pre-checks the balance; the debit stays authoritative.
- **Reward points (W4):** a separate double-entry ledger (`points_*`) with AVAILABLE / PENDING / DEBT
  buckets checked against SUM(postings) at commit, and lots for FIFO-by-expiry spending, exact
  expiry and reversal. Earned on `order.delivered.v1.netPaidPaise` (PENDING for the hold days);
  a refund reverses the refunded share (own lot → other lots → DEBT, settled by the next earn).
  Conversion = points debit + wallet credit in ONE transaction; lock order is always points account
  → wallet account (conversion and top-up cashback).
- **Staff console (W5):** manual adjustments need two people (requester ≠ approver in the service,
  a DB CHECK and a final-state trigger); posting happens in the approval transaction with key
  `adj:<id>`. Freeze blocks debits only. A 15-minute ledger check re-derives every balance from the
  postings and lots (the triggers stop bad writes; the check catches anything that bypassed them).
  Permissions: `wallet.view`, `wallet.adjust`, `wallet.approve`, `wallet.configure`.
- **Cost:** one extra service. Table ownership is enforced by code + triggers, and by DB roles
  once `infra/sql/wallet-roles.sql` is applied (wallet-service = `farmx_wallet`, others =
  `farmx_app`, migrations = owner). Guide and runbook: `docs/wallet/README.md`.

### D-55 · Help & Support → support-service (:3013); shared WebSocket layer; self-service account deletion

- **Scope:** one support-service for all four requester apps (CUSTOMER, VENDOR, LOGISTICS,
  WAREHOUSE — the app comes from the token's user type): tickets + live chat, FAQ (search, votes,
  "These may answer it"), versioned legal pages (Privacy Policy …), and the agent console queue.
  Agents are staff with `support.*` permissions; phone / email / WhatsApp tickets are logged by
  agents into the same queue (`channel`).
- **Dynamic priority + SLA:** admin priority rules (first match by sortOrder: temperature classes of
  the snapshotted order, order amount, whole-word keywords, requester type; scoped by app / topic)
  else the topic default. SLA policy per app × priority; business-hours calendars (IANA zone,
  split windows, holidays; DST-safe via luxon). The policy is snapshotted on the ticket. Resolve
  clock pauses in WAITING_ON_REQUESTER (paused working minutes extend the due), restarts on reopen;
  a manual priority change recomputes from the original start. Breaches + auto-close run as ONE
  set-based `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` over partial indexes every
  30 s / 10 min (exactly once across replicas; no per-ticket delayed jobs needed).
- **Concurrency:** ticket no. from a Postgres SEQUENCE; message `seq` gap-free per ticket
  (`UPDATE … lastSeq+1 RETURNING`); `Idempotency-Key` (unique per requester) and
  `clientMessageId` (unique per ticket + sender) make retries safe; claim is a conditional UPDATE
  (one winner); agent actions take `If-Match`; the open-ticket cap runs under an advisory lock;
  auto-assign picks the least-loaded online + accepting agent with `FOR UPDATE SKIP LOCKED`.
  Unread = public messages after the reader's `lastReadSeq` (internal notes never count).
- **One WebSocket layer (`@farmx/infra/realtime`):** upgrade on one path, single-use 60 s connect
  token (GETDEL, audience-bound; browsers cannot send headers), Origin allowlist, per-user socket cap
  and frame rate limit (Redis, shared by replicas), 16 KB frames, JSON protocol with ack / error,
  heartbeat, backpressure drop, session re-validation (revoked sid → close 4001), graceful close,
  rooms + audiences fanned out over ONE Redis pub/sub channel. Services only add frame handlers
  (support: subscribe / message.send / typing / read / queue.subscribe). Agent actions and internal
  notes are REST-only; internal notes reach agent sockets only. Gateway: `/v1/support/chat` is the
  only WebSocket-enabled proxy route. Delivery is best effort: clients resync with `afterSeq`.
- **Uploads:** media-service `POST /upload?purpose=support` stores PRIVATE objects and returns an
  HMAC-signed receipt (uploader, key, type, size, scan status, 1 h). support-service verifies it
  locally (no network) and binds each key to one ticket (unique). Images are re-encoded; PDFs are
  scanned by clamd (`CLAMAV_HOST`; prod refuses PDFs without a scanner). Reads: 5-minute signed
  URLs via `/internal/media/sign-read` after the ticket-access check.
- **Delete Account (auth-service `deletion`):** step-up OTP → PENDING_DELETION + every session
  revoked (revoked-sid flags kill access tokens in all services and close chat sockets) → normal
  login 403 `ACCOUNT_PENDING_DELETION`. Recovery: OTP → single-use 10-minute recovery token (not
  a JWT) → cancel → ACTIVE. After `ACCOUNT_DELETION_GRACE_DAYS` (30) an hourly job (SKIP LOCKED)
  deletes credentials / MFA / devices, anonymises the user (email tombstone
  `deleted-<id>@deleted.invalid`, phone freed) and emits `user.deleted.v1`; support-service scrubs
  requester text and files. auth-service now has an outbox relay (`user.status_changed.v1`,
  `user.deleted.v1`, also from admin status changes / deletes).
- **Permissions:** `support.view|manage|assign|escalate|configure`, `faq.manage`, `legal.manage`.

### D-56 · Warehouse portal → warehouse-service (:3014); Login + Multi-Warehouse (W2); invite-only staff

- **Scope (approved 2026-11-23):** backend for the warehouse portal's Login and Multi-Warehouse
  screens (W2.01–W2.09, every Figma field backed by an API). Dashboard W1, Gate W5 and the React UI
  are out of scope for now. Plan: `~/.claude/plans/tell-one-thing-in-graceful-pine-…md`.
- **Ownership:** the warehouse master + PIN coverage move from inventory-service to
  warehouse-service. inventory keeps `inventory_warehouses` / `inventory_warehouse_coverage` as an
  event-fed, version-guarded projection with the SAME ids (`warehouse.upserted.v1`,
  `warehouse.coverage_replaced.v1`), so stock, reservations and allocation are unchanged. Imported
  coverage keeps its exact priorities (no routing change); missing data (district, manager,
  capacity) is flagged for review, never guessed.
- **WAREHOUSE-scoped RBAC (P0, done):** auth's effective access now carries
  `warehouses: { <warehouseId>: permission[] }` from WAREHOUSE assignments (only keys whose catalog
  scopes allow WAREHOUSE). Before this, scoped assignments granted nothing. The cached entry has a
  shape marker (`s: 2`); other services keep reading GLOBAL `permissions` unchanged. New
  permissions: `warehouse.view|configure|operate` (GW), `warehouse.create|status_change` (G,
  sensitive), `warehouse.team_manage` (GW, sensitive).
- **Invite-only staff (P0, done):** no public sign-up. warehouse-service calls
  `/internal/staff/invitations` (create or reuse an INTERNAL account, grant the role at that
  warehouse, email a 48 h code); the person accepts at `POST /auth/invitations/accept` (code +
  first password, same 400 for any failure) and signs in with `/auth/admin/login`. auth re-checks
  that the caller holds `warehouse.team_manage` THERE and that the role is a warehouse template
  granting nothing the caller lacks there (no privilege escalation); the same rule applies to
  removal (`/internal/staff/assignments/revoke`, ends the member's sessions). Granting only
  refreshes the access cache. Phones are not stored on invited accounts (phones are unique across
  all users); the warehouse keeps its own copy.
- **Roles are global templates:** warehouse screens read them (`/internal/access/warehouse-roles`)
  but never edit them; central admins edit through `PUT /admin/roles/:id/permissions` after
  `GET /admin/roles/:id/usage` ("used by N staff in M warehouses").
- **Event data for the warehouse read model (P0, additive):** `inventory.reservation_committed.v1`
  `lines[{warehouseId, variantId, qty}]`; `inventory.reservation_released.v1` lines are per
  (warehouse, variant) with `warehouseId`; `order.placed.v1` `shipTo {name, district, pinCode}`;
  `VariantFactsV1.weightGrams` (gross grams of one sellable pack → capacity in kg).
- **P1 (done):** warehouse-service :3014 (`/v1/admin/warehouses`, `/v1/admin/wms`): warehouse master,
  SETUP → ACTIVE ↔ LIMITED → INACTIVE state machine with an activation checklist, list / summary /
  CSV export, service areas (districts, PIN ranges, priority HIGH 10 · MEDIUM 50 · LOW 90, imported
  PIN reassign), coverage preview, portal `me` + search. Migration `20261209100000_warehouse_service`
  copies inventory warehouses + coverage (local DB only). inventory's warehouse admin routes are gone;
  its tables are the projection. Districts are free text with suggestions (no official district
  master yet; an LGD import can make them strict later). Prisma 7's adapter does not name the
  violated index, so 409 reasons come from pre-checks plus a re-read after a race.
- **P2 (done):** setup screens. Migration `20261210100000_warehouse_setup` (local DB only).
  - Storage: zones → racks → bins with generated codes (`A`, `A-01`, `A-01-01`). The sum of bin
    limits stays within the rack's weight and volume, checked under the rack's row lock.
  - Dock & yard: doors, bookings, staging areas and yard slots. A `btree_gist` exclusion
    constraint stops overlapping open bookings on one door; a locked pre-check gives the 409
    `DOCK_BUSY` first. Unloading capacity is reported per unit (tonnes, pallets), never summed. A
    door's unit is frozen while it has open bookings.
  - Calendar: 7-day hours, shifts (overnight allowed, break inside the shift), holidays (closed or
    limited hours) and cut-offs, all `HH:mm` in the warehouse timezone.
  - Storage rules: saved with `enforcement: NOT_ENFORCED` until put-away (W8). `warnings[]`
    (e.g. `SAME_ZONE_CONFLICT`) mark a rule "needs review". Distance is stored in metres and
    measured between zones.
  - Team: invite-only through auth (`team_manage` at the warehouse, no escalation). The phone and
    work areas live in `warehouse_staff_profiles`, because auth phones are unique per user. The
    roles panel is read-only.
  - Staff documents: a new private media purpose, `staff_document` (folder `staff/`). Receipts are
    HMAC-signed by media-service and verified locally; each consumer checks its own `purpose`.
    Files are read only through 5-minute signed URLs.
  - The activation checklist now also needs an active zone and weekly hours.
- **P3 (done):** W2 numbers. Migration `20261211100000_warehouse_stats` (local DB only).
  - inventory: the variant projection keeps `rootCategoryId` (= `categoryPath[0]`) and
    `weightGrams`; the migration backfills both from product + catalog tables. New internal
    `GET /internal/inventory/warehouse-stats` gives, per warehouse, on hand / reserved / damaged /
    sellable, SKU count, `usedKg` (integer grams → kg, unknown weights excluded and counted) and
    stock by root category.
  - warehouse-service pulls it with one BullMQ job (`refresh-stats`, every
    `STATS_REFRESH_SECONDS`, default 60) into `warehouse_stock_current`,
    `warehouse_stock_by_category` and today's `warehouse_daily_stats` row (the last refresh of
    the local day wins; gives "vs last 7 days" and "vs yesterday"). Screens read only these rows. If
    inventory is down, the last snapshot stays, with `stale: true` after 3 missed refreshes.
  - Order read model from events (see event-contracts): NEW → ALLOCATED → DELIVERED, or
    CANCELLED. Deactivation returns 409 `HAS_OPEN_ORDERS` while NEW or ALLOCATED rows exist.
  - New screens: `GET /:id/overview` (cards, status board, information box), `GET
/:id/stock-by-category`, `GET /:id/orders`. W2.01 list rows, the summary and `GET /:id` now
    carry stock units, used kg and capacity use %.
  - Cards whose module does not exist yet (transfers, picking stages, performance, near-expiry)
    return null with `modules` flags.

### D-57 · Warehouse portal Order Fulfilment (W3) + In-stock Management (W4); WMS owns physical stock; OMS F1 shipments

- **Scope (approved 2026-11-23, built 2026-11-24):** every widget of W3.01–W3.16, W3.18 (prepaid
  parts), W3.19 (views) and W4.00–W4.11 has its own API, on two audiences with the same handlers:
  warehouse panel `/v1/wms/*` (caller's warehouses; out of scope → 404) and admin panel
  `/v1/admin/wms/*` (GLOBAL grants). Customer `/v1/shipments/*`, 3PL driver link `/v1/driver/*`.
  Plan: `~/.claude/plans/c-projects-farmax-documents-fa-compiled-teapot-…md`. W3.17 Scheduled,
  W3.18 credit and W3.19 "Create bulk order" are a later phase (business sign-off: prepaid only).
- **D-57a stock (Phases 1–2):** warehouse-service owns batch × bin × status × owner stock
  (columnar positions, one writer `stockEngine.apply`, every move checked against the lifecycle
  table), receipts (CN / RT), unit QR, COA, quality, adjustments (maker-checker), thresholds,
  vendors, restock (RST, approve ≠ requester) and transfers (TR). inventory keeps warehouse × SKU
  totals + reservations, fed by `warehouse.stock_changed.v1`; its stock-write APIs follow the
  `stockWritesMode` flag (INVENTORY → FROZEN → WMS) with a 72 h rollback window.
- **D-57b fulfilment (Phases 3–5):** the OMS F1 shipment (one OPEN shipment per order × warehouse;
  a backorder follow-up may ship later) with the state machine PENDING_RELEASE → … →
  READY_TO_DISPATCH → DISPATCHED → OUT_FOR_DELIVERY → DELIVERED → FULFILLED (+ DELIVERY_FAILED,
  RETURNED_TO_WAREHOUSE, CANCELLED; hold is a flag). order-service derives IN_FULFILMENT /
  PARTIALLY_DELIVERED / DELIVERED from `shipment.status_changed.v1` and emits
  `order.delivered.v1`. Each snapshot entry carries the shipment `version`; order-service merges
  them into `orders.shipmentStates` (highest version per shipment wins), because two shipments
  changing at once can each publish a snapshot without the other's change, and events can arrive
  late or out of order. So neither the status nor `fulfilmentStage` (cancel / delivery-edit
  rules) ever moves back on an old event. Gate-out sends `shipment.dispatched.v1` keyed by `dispatchId`; inventory
  issues against the reservation line once (an over-issue → `inventory.issue_rejected.v1` →
  ISSUE_MISMATCH exception).
- **Cross-service reallocation** is a saga (local PENDING → inventory reallocate with an
  idempotency key → local apply → COMPLETED; definitive refusal → FAILED; repeated apply failure →
  COMPENSATED). Allocation reconcile acts only on a mismatch seen twice, never on picked stock, and
  counts open backorders as held.
- **Delivery (D-40 kept):** OTP HMAC + AES-GCM, 12 h, 5 tries, shown in the customer API only —
  never to staff, logs or events. Prepaid settlement ("Settle now") = shortage refund / confirm /
  POD / second-person override approval. 3PL drivers use a hashed 32-byte trip link.
- **Routing rules (W3.12):** rules live in warehouse-service; every change publishes ONE versioned
  snapshot `warehouse.routing_rules_replaced.v1`; inventory applies it at checkout through the
  shared pure evaluator `@farmx/infra/routing` (WMS uses the same one for simulation and W3.04).
  Paused nodes and nodes over their daily cap (cap watch republishes) are skipped. LOWEST_COST is
  listed `available:false` (no fare rates).
- **ATP (W3.13):** net ATP = physical − open demand (+ open backorders) − safety − QC hold −
  blocked − returned; projected 24 h adds transfers due. Storefront sync from
  `inventory.availability_changed.v1`. inventory owns the buffer floor (`bufferFloorPct`, hides
  stock at or below reorder level × % from the storefront) and the cart-hold lease; WMS edits them
  through inventory's internal API.
- **Split / partial / backorder (W3.14):** moved legs run the reallocation saga one at a time;
  backordered units keep their inventory reservation (first claim on incoming stock) and the
  backorder job ships them when stock arrives. Partial-ship CANCEL and backorder cancel go through
  order-service's normal cancel (refund + release; new internal `POST /internal/orders/:id/cancel-lines`).
- **Amendments (W3.15):** delivery details are owned by order-service (new
  `PATCH /v1/admin/orders/:id/delivery`, internal twin, `order.delivery_updated.v1`); decreases =
  cancel + refund. **Increases are refused** (409 BALANCE_PAYMENT_NOT_AVAILABLE): a prepaid order
  cannot take a balance payment yet (needs multi-payment orders in payment-service).
- **Cost:** many new tables (migrations 2026-12-14 … 2026-12-19, local DB only, not Neon); the
  D-56 `orders` read model stays for W2.03; driver-link SMS is not integrated (the link is returned
  to the dispatcher); amendment increases and per-leg planned trips are open items.

### D-58b · Customer profile + farm profile edits match the Figma (account is the source of the owner name)

- **Problem (2026-11-24):** `GET /v1/auth/me` (auth `users`) and `GET /v1/farms/:id` (farm
  `farm_owners` + `farms`) are different records; the owner name and phone were stored twice with
  no sync, and every customer edit was blocked once a farm was ACTIVE.
- **Account = source of truth** for name / phone / email / photo. New CUSTOMER-only
  `PATCH /v1/auth/me` and `POST /v1/auth/me/phone/otp` + `/verify` (OTP to the NEW number, bound
  to `userId|phone`, 409 `PHONE_TAKEN` / `EMAIL_TAKEN`; new email stored unverified). Each change
  is audited and emits `user.profile_updated.v1`.
- **farm-service gets its first event consumer** (queue `farm-service.events`, `EVENTS_ENABLED`,
  `RABBITMQ_URL`): syncs the owner snapshot; a blank account name (fresh phone sign-up) never wipes
  the name typed at registration. The farm outbox **relay is still not started** (separate
  rollout: existing outbox rows would all publish at once).
- **ACTIVE farm edits:** `PATCH /v1/farms/:id` accepts ranked `productionTypes` (+ capacities);
  `[0]` stays fixed because it is in the Farm ID (409 `PRIMARY_TYPE_LOCKED`).
  `PUT /v1/farms/:id/location` works on ACTIVE farms inside the same territory only (409
  `TERRITORY_LOCKED`); it emits `farm.updated.v1`.
- **Read model:** `location.primaryNodeName / backupNodeName / deliveryPromise` come from the geo
  pin directory at read time (no new columns); `owner.panVerified / aadhaarVerified` booleans.
  An accepted PAN card locks the PAN (409 `PAN_LOCKED`).
- **"Keep farm name & send for review" (option A, approved by the owner 2026-11-24):** new
  nullable `farms.invoiceNameReview` (PENDING / APPROVED / REJECTED) + requested/reviewed
  timestamps, reviewer id and note (migration `20261222100000_farm_invoice_name_review`).
  `PUT /farms/:id/billing` with FARM_NAME when the GST names differ → PENDING, and invoices use
  the GST trade name meanwhile (valid for ITC). Staff queue `GET /v1/admin/farms?invoiceNameReview=PENDING`;
  `POST /v1/admin/farms/:id/invoice-name/{approve|reject}` (`customers.verify`, reason, If-Match,
  reviewer ≠ owner/registrar, audited). Approve → `FARM_NAME`; reject → stays on the trade name,
  the reason is shown to the owner. Choosing GST_TRADE_NAME withdraws a pending request.
- **Name-match rule fixed:** `nameMatchesFarm` (GSTIN check) used the lenient `namesMatch` (any
  shared 3-letter word), so the Figma pair "Sri Lakshmi Agro Farms" / "Sri Lakshmi Poultry" counted
  as a match and the mismatch banner never showed. It now uses strict `sameBusinessName` (case,
  spacing, punctuation ignored), the same rule that decides the review. `namesMatch` stays for the
  Aadhaar owner-name check.
- **Deferred (product decisions / other features):** "Gold member" tier (membership feature),
  profile-completeness %, sheds / vaccination schedule / consulting vet / water & litter fields
  (vet + flock features). No push to the owner on the review decision yet (the farm outbox relay
  is off); the app reads `billing.invoiceNameReview`.

### D-59 · Home SDUI: server-driven Home + All Categories pages in user-service

- **Why (2026-11-24):** the app's Home and All Categories screens were hard-coded. Admins now
  reorder, show/hide, schedule, target and A/B-test every block from the CMS without an app
  release. Built **only in user-service** (`features/home`); other services got one-line wiring
  (gateway `/v1/home` + `/v1/admin/home`, permission module `home_layout.view|manage|publish`,
  `userKeys.home*`).
- **Model** (migration `20261223100000_user_home_layouts`): `home_configurations` (layout per page
  HOME | CATEGORIES; DRAFT → SCHEDULED / PUBLISHED → ARCHIVED; `layoutNo`, per-page `publishRev`,
  `settings.orderPhones` by region, `version` for If-Match) → `home_sections` (one widget each:
  14 widget types × 7 data sources, localized `{ en, hi? }` text, `itemLimit`, `minItems`,
  `inline`, `experimentKey`, per-widget `config`, `targeting`) → `home_section_items`. Partial
  unique indexes: one PUBLISHED and one SCHEDULED layout per page.
- **Banners are reused from catalog-service** (`BANNER_PLACEMENT` = a placement code); no
  `home_banners` table. Categories can come live from the catalog (`CATALOG_CATEGORIES`).
- **Product cards = the catalog listing's own product-service card** + `tracking`, `actions`
  (ADD_TO_CART / UPLOAD_RX, PHONE_ORDER by region), `priceBreak` (null until product-service has
  it), `inStockAtDepot`. Wishlist hearts stay out of cached responses (`/me/wishlist/ids`, cap 500).
- **Reads:** `GET /v1/home/layout` (snapshot in-process 5 s → Redis 30 s → DB, filtered per
  request in memory; up to 3 `inline` product sections carry page 1 within a 350 ms budget),
  `GET /v1/home/sections?keys=` (batch ≤ 6) and `/sections/:key` (cursor),
  `GET /v1/home/feeds?keys=` (allowlisted keys only, 400 ms each). Never 401: an expired token
  is served as a guest with `meta.authState: expired`. ETag over the body + `private, no-cache`.
- **Targeting is server-side:** region + depot come from the farmer's own farm (`X-Farm-Id` picks
  among the user's ACTIVE farms, else the oldest; cached 10 min, no farm event to clear it);
  `X-Region` / `nodeId` from the app are ignored; guests have no region. Old apps: `X-SDUI-Version`
  drops widgets newer than the app. A/B bucket = hash(device id + salt), stable across login.
- **Publishing:** If-Match on every write (missing → 400 `IF_MATCH_REQUIRED`, stale → 409);
  publish and rollback both re-check every referenced category / brand / disease / flock stage /
  product / placement (broken active ref → 422, service down → 503); schedule = lazy flip on the
  first read after its time (no job runner); each publish / rollback / flip gets a new
  `publishRev`, which is in every section cache key. Every change is audited (`user_audit_log`,
  target `home_layout`).
- **Future (blank until the data exists):** price breaks; flock stage / week / shed and "products
  for this stage"; isNewUser / hasActiveOrder / segments targeting (rules on them never match);
  feeds APPOINTMENT_NEXT (no call bookings), BUY_AGAIN, VET_AVAILABILITY (no general endpoint),
  REQUIREMENT_DUE; guest region (pincode lookup needs login); image CDN variants + blur
  placeholder; catalog/product deactivate events (user-service has no consumer: ref check at
  publish + `POST …/validate` instead); Prometheus metrics (Pino line per request now).
- **Seed:** `pnpm --filter @farmx/user-service home:seed` creates the Figma HOME + CATEGORIES
  layouts as DRAFTs (idempotent). Create banner placement `HOME_TOP` and pick brands before
  publishing.

---

### D-60 · W16 Sampling & COA → quality-service (:3015); user-side COA; warehouse executes stock moves

- **Why (2026-11-25):** the user asked for W16 (Sampling & COA) and the customer COA screens (C-23 / C-24 / C-25) in a separate service. quality-service **decides**; warehouse-service stays the **only writer of stock** and executes decisions. Release rule is **per SKU** (default MANUFACTURER_COA: QA releases on the approved manufacturer COA, the independent test runs in parallel; INDEPENDENT_COA: release waits for the independent PASS). Labs = manual result entry (LIMS later). User side = COA only (farm stock posting later).
- **Transaction safety:** every change + its audit row + its outbox event commit together; consumers run in the inbox transaction. The receipt event creates the AUTO sample (one per receipt × batch, partial unique index); the warehouse decides QC_HOLD from its own policy projection (no sync call at receipt time).
- **Fail cascade:** a decision = one task per warehouse holding the batch, each executed in its own transaction (row-locked positions, the stock engine, audit, task event). Key = decision × warehouse, status checked under lock → never moved twice. Backoff 1m / 5m / 15m / 1h, FAILED after 6 → decision PARTIAL; `POST /decisions/:id/retry` re-queues only FAILED tasks. Older decisions are SUPERSEDED (`warehouse_batches.qualityVersion`). Blocked batches: later receipts → QUARANTINED, FEFO skips them. Buyers are told at decision time, once per decision × user.
- **Concurrency:** `quality_batch_states.version` (UPDATE … WHERE version = expected) gates every decision; one APPLYING RELEASE per batch (partial unique index); versions on samples, COAs, specs and labs; Idempotency-Key on decisions.
- **Security:** customer routes only show batches the caller received (`quality_batch_buyers`, fed by gate-out); the unit scan shows the order / delivery only to its buyer; the public verify page is an explicit allow-list. Four-eyes: whoever entered results cannot review them. Approve = GLOBAL `traceability.coa_verify`; release / recall = GLOBAL keys.
- **Auditability:** `quality_audit_logs` append-only (trigger); results keep enteredBy + the spec version; the warehouse ledger stores refType QUALITY + the decision.

---

### D-61 · Invoices go live: issued at gate-out, credit notes, customer / warehouse / admin access

- **Why (2026-11-25):** the D-48 invoice core existed but nothing called it and nobody could download (Figma `FarmX Marketplace-4`: "Download tax invoice", "Download Combined Invoices", "GST invoice generated upon dispatch"). The user chose invoices + warehouse print + credit notes + an admin register, with six review points: distributed transaction, credit-note accuracy, immutability, PDF reliability, warehouse access control, GST compliance — and every API fast, race-free, in Swagger and tested.
- **1 · Invoice ↔ dispatch (two databases → saga, no HTTP inside a transaction).** Gate-out (`POST /v1/wms/dispatch/trips/:id/depart`) first checks access + trip state, then asks order-service `POST /internal/orders/:id/shipments/:shipmentId/invoice` for each READY shipment (4 in parallel, 3 s timeout, 1 retry — safe: idempotent). The request carries the packed lines (order line + packed qty) and a `linesHash` (sorted `line:qty`, SHA-256, 16 hex; both services share a test vector); order-service recomputes it (409 `LINES_HASH_MISMATCH`). Then the warehouse transaction dispatches and **re-checks the hash under the shipment row lock** (409 `INVOICE_STALE` → depart again). Refused → 409 `INVOICE_BLOCKED`, unreachable → 503 `INVOICE_UNAVAILABLE`; either way the trip stays as it was. Key `ship:<shipment>:<hash>:<generation>`: same lines → replay; different lines before gate-out → the old invoice is **voided by a full credit note and a new one issued in the same order-locked transaction**; after gate-out (`orders.shipmentStates` ≥ DISPATCHED) → 409 `ALREADY_DISPATCHED`. A shipment later CANCELLED with an active invoice → void credit note from the `shipment.status_changed.v1` consumer, plus a 15-min `invoice-reconcile` job (index-driven: recent active invoices → their orders' states). `DISPATCH_REQUIRE_INVOICE` (Joi forces true in prod) lets dev / test without a seller GSTIN dispatch with a logged warning. `ewayBillRequired` (value > `EWAY_BILL_THRESHOLD_PAISE`, default ₹50,000) is a warning in the depart response.
- **2 · Credit notes — financial accuracy.** Pure `buildCreditNote`: integer paise; per invoice line and per tax head `credit = cumulative(amount, c + k, qty) − cumulative(amount, c, qty)` (same rule as invoices) → notes never exceed the line and add up to it exactly when fully credited (500-case property test). Supply type / split copied from the invoice. Freight only on a full void. **Refund = credit note:** the shortage refund amount is the credit note's grand total (capped by what is refundable), so the money ledger and GST books agree to the paisa. A void is only automatic on an invoice without other credit notes (no mixed arithmetic). CGST s.34(2): after 30 Nov following the invoice's FY no credit note is issued — the refund proceeds and an ALERT is logged. GSTR-1 section: CDNR (registered) · CDNUR (original B2CL) · B2CS.
- **3 · Immutability.** On top of D-48 (no DELETE / TRUNCATE, only PDF / IRN / status columns change), migration `20261225100000_invoice_hardening`: status only moves forward (ISSUED → PARTIALLY_CREDITED → CREDITED), a credit note never changes status, `pdfKey` / `pdfSha256` are set once, READY never goes back. Every render / download / print re-verifies the snapshot's SHA-256 (tamper → 500 + ALERT); stored PDFs are re-verified against `pdfSha256`.
- **4 · PDF reliability.** Existing SKIP LOCKED claim + attempt guard + stale recovery + backoff kept; the 10-s scheduler is the trigger (nothing to lose); the claim query now matches the partial index; 10-s render timeout; fonts loaded once per process. Warehouse print and the combined PDF never wait for the job (render from the verified snapshot). Combined PDFs are cached in a per-replica in-memory LRU keyed by the document set (ids + snapshot hashes) — immutable inputs, so never stale.
- **5 · Warehouse access.** `GET /v1/wms|admin/wms/fulfilment/shipments/:id/invoice.pdf`: `fulfilment.view` scoped to the shipment's warehouse; outside scope → 404 like a missing shipment; only that shipment's active invoice; audited; 30/min; no driver access. The order-service PDF route is internal (service token checked before validation, never routed).
- **6 · GST compliance:** `docs/invoices/gst-compliance.md` (Rule 46 fields → code / tests; points needing CA sign-off).
- **APIs:** customer `GET /v1/orders/:id/invoices` (another buyer's order → empty list, no leak), `…/invoices/:docId/download` (`{url, expiresAt}` 5-min signed; 409 `PDF_NOT_READY` + `Retry-After: 5`), `…/invoices/combined` (PDF, ≤ 20 docs); admin `/v1/admin/invoices` (search with id-keyset paging and date range as UUID-v7 bounds, detail, audited download, PDF retry, GST register CSV ≤ 31 days, streamed, CSV-injection safe). New permissions `invoices.view`, `invoices.export` (run `pnpm db:seed`). Gateway `/v1/admin/invoices`.
- **Measured (`pnpm --filter @farmx/order-service bench:invoices`, local laptop, Postgres in Docker):** service time p97.5 — list 7 ms, register 9 ms, register by order 9 ms, download 12 ms; one Node process at 4 concurrent clients — list ≈ 370–430 req/s at p97.5 17 ms, register by order ≈ 400–470 req/s at 15 ms, register ≈ 250–270 req/s at 24 ms; combined PDF repeat 12 ms, first render (5 docs) p50 ≈ 80 ms, p97.5 ≈ 190–200 ms (gated at 300 ms).
- **Not built:** manual credit notes (`invoices.manage`), ZIP-of-PDFs export, e-invoice IRN / QR, e-way bill generation, `invoice.issued.v1` notification.
- **Future — move PDF rendering to a worker thread (added 2026-11-25 at the user's request):** today every render (background `invoice-pdf` job, combined PDF on a cache miss, warehouse print before READY) runs on the API's event loop, ~15–20 ms of CPU per invoice. During bulk dispatch (many trips departing → many invoices queued) or high load, those renders block request handling and raise API latency on that replica. Plan when needed: a small `worker_threads` pool (size `INVOICE_PDF_CONCURRENCY`) behind the same `renderInvoicePdf` / `renderCombinedPdf` signatures (snapshot in, bytes out, deterministic output unchanged), or a separate renderer process consuming the `order-invoice-pdf` queue; check that tsup emits the worker entry for the production build. Trigger: API p97.5 rising while `invoice-pdf` jobs run.

---

### D-62 · W5 Gate & Weighbridge in warehouse-service (feature `gate`)

- **Why (2026-11-25):** Figma `FarmX warehouse-gate-5` (35 screens W5.01–W5.13) + the Warehouse Screen Flow PDF W5: _Appointment / ASN > Arrival > Gross weight > Verify documents > Approve > Gate pass > Receiving > Exit tare > Net weight > Outward gate pass_. Plan rev 3 (`C:\Users\HP\.claude\plans\c-projects-farmax-documents-fa-effervescent-tiger-…md`) after two user reviews (30 points).
- **User decisions:** PO = an approved PROCUREMENT restock request (RST) + a free-text vendor PO number; weighbridge = **manual entry only** (live device feed Future); receiving = CN link (several CNs per truck, `finalForGate` unloads) **and** a manual "unloaded" button (reason required without a CN → `noReceipt`).
- **Model:** inbound shipment `INB-YYMM-####` (SHP is outbound) → gate entry `GE-…` (one vehicle visit; one ACTIVE entry per shipment and one per truck per warehouse = partial unique keys freed at EXITED / CANCELLED) → append-only weighments (one ACTIVE + one PENDING_APPROVAL per kind) → passes `GPI` / `GPO` (one live per type) → timeline `warehouse_gate_events` (append-only trigger, ids / codes only). Registers: ASN (+ lines with convertedQty), visitors `VIS`, outward material `OM`, security checks. Dock appointments reuse `WmsDockDoor` / `WmsDockBooking` (+ inboundShipmentId, vendorId, asnId, confirmedAt; the booking window is never changed by actual times — dockIn / dockOut live on the entry).
- **State machine (gate.rules.ts, unit-tested row by row):** ARRIVED → WEIGHED_IN → APPROVED (GP-IN) → UNLOADING → UNLOADED → WEIGHED_OUT → PASS_OUT → EXITED. Pauses BLOCKED / HELD store `pausedFromStatus` (unblock resumes there; HELD accept → WEIGHED_OUT). **Turn-away** only before unloading: REJECTED + GP-IN VOID + dock booking CANCELLED in one transaction; optional exit re-weigh (same tolerance vs gross; mismatch → AUTO security HOLD that blocks pass-out / exit); GP-OUT (outcome REJECTED); the shipment action is applied **at EXITED**: REEXPECT → EXPECTED + `rebookingRequired` (gate-in 409 until a new slot) + vehicle-bound / expired documents back to PENDING, others carried forward; CANCEL → CANCELLED. No load rejection after a CN: HELD offers ACCEPT_VARIANCE / REWEIGH (supersedes the ACTIVE reading in the same transaction) / ACCEPT_WITH_DEBIT_NOTE (flag for W6.12).
- **Weight basis:** expected load = invoice gross, else declared net + packaging allowance (per purpose: pct + per-pallet kg); tolerance = max(pct × expected, minKg); no computable expected load → HELD `NO_DECLARED_WEIGHT` (never a silent pass). Scales: calibration in date or 409 `CALIBRATION_EXPIRED`; weight ≤ capacity.
- **Concurrency:** state-guarded `UPDATE … WHERE status = $expected` under the entry row lock; PO row `FOR UPDATE` for wizard / edit / ASN match / ASN convert (remaining = approved − received − open shipments − open ASNs); ASN row `FOR UPDATE` + convertedQty; QR scan ISSUED → USED atomically (scan vs reissue: one wins); pending override and open security hold block approve / pass-out / exit; maker ≠ checker for overrides (capturer), hold resolution (tare capturer), outward material (creator). Every read inside a transaction uses that transaction (pool-starvation bug found by the ×10 race tests and fixed).
- **Idempotency:** generic `middleware/idempotency.ts` on every gate write: Redis `warehouseKeys.idempotency(user, route, key)` = {body SHA-256, status, response}, 24 h; different body → 422 `IDEMPOTENCY_KEY_REUSED`, in-flight → 409, done → replay (`idempotent-replayed: true`). DB guards remain the backstop when Redis is down.
- **Caching / speed:** dashboard reads cached in Redis under `gate:v:{wh}` (INCR after every committed gate write, CN receipt with gateEntryId and INBOUND docks booking change) + the minute bucket; the ETag carries the same parts → 30 s auto-refresh answers 304 with no DB hit; "today" = the warehouse timezone. Redis failure → computed from Postgres (≤ 60 s stale only if a post-commit INCR fails). Measured on the local DB with 50k shipments / 50k entries / 200k events (seeded in a rolled-back transaction): table 3 ms, KPI summary 22 ms, tab counts 22 ms, trigram search 33 ms, activity 0.4 ms, timeline 0.9 ms, vehicle lookup 0.15 ms — all index scans.
- **Security / PII:** permissions `gate.view|operate|approve|security|configure` (GW scopes; run `pnpm db:seed`); QR = own key set `GATE_PASS_QR_KEYS` (kid → secret, rotation) + `GATE_PASS_QR_ACTIVE_KID` (dev: HKDF of the service token); expiry → 409 `PASS_EXPIRED` (410 is not in the shared error catalogue) + reissue API. Mobiles masked in lists / pass snapshots; audit payloads sanitised before writing (mobile / DL / RC masked); outbox events carry ids only; daily `gate-pii-retention` job anonymises visitors (90 d) and drivers (180 d) and deletes DL / RC scans via media-service `/internal/media/delete`. Media purpose `gate_document` (PDF / JPEG / PNG / TIFF ≤ 25 MB; TIFF only for this purpose).
- **CN link (stock receipts):** `POST /wms/stock/receipts {gateEntryId, finalForGate}` always posts; links only while UNLOADING…PASS_OUT (HELD by its paused status), else `warnings[GATE_LINK_SKIPPED]`; a link clears `noReceipt`.
- **Scope:** one active truck per shipment (split consignments = ASN partial convert, one shipment per truck). Future: live weighbridge feed, ANPR / CCTV, OCR, NIC e-way bill API, Sarathi DL check, inbound live route map, boom barrier, vendor-portal ASN UI (the internal API `/internal/wms/gate/asns` is ready), SMS / WhatsApp alerts, W6 receiving screens (debit note, NO_RECEIPT follow-up), a real PO module, one shipment across several trucks. Document numbers keep the YYMM style (`GE-2611-0042`).

**Open questions:** how OTPs are delivered (auth-service still sends them directly; moving them
to the notification service would need an internal send API and an SMS gateway), production Postgres hosting, and the Node 24 upgrade.
