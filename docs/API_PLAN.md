# FarmX — API Plan and Data Model

**Status:** ✅ = built. Everything else is a **plan** derived from the requirements; confirm it
before building.

**Conventions**

- Public path is `/v1/<service>/<path>` through the gateway; the paths below are service-relative.
- JSON envelope; cursor pagination (`cursor`, `limit`); `Idempotency-Key` on POST, PUT and PATCH
  for payments and offline sync.
- Admin routes live under `/admin/*`, own-record routes under `/me/*`.
- **Role** column: a permission key (admin RBAC), or a persona for external users
  (CUS = customer, VND = vendor, DRV = driver, VET, PUB = public).

**Proposed services** (to be confirmed — see Open questions):

- **auth:** identity, users, RBAC, sessions, audit
- **party:** customers, farms, KYC, vendors
- **catalog:** catalogue, pricing, search, promotions
- **order:** cart, checkout, orders, returns, recurring
- **payment:** payments, refunds, settlement, finance
- **clinical:** consultations, prescriptions
- **logistics:** procurement, WMS, inventory, consignments, driver, cold chain, QMS, trace
- **engagement:** loyalty, leads, ads, liquidation, content, support, notifications

## 1. Auth + RBAC (auth-service) — ✅ built

| Method              | Path                                                | Auth / permission                    | Request → Response                                                                                |
| ------------------- | --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| ✅ GET              | `/.well-known/jwks.json`                            | public                               | Ed25519 JWK Set (gateway verification)                                                            |
| ✅ POST             | `/auth/otp/send`                                    | public · 5/h per phone, 20/h per IP  | `{ phone }` → `{ sent, expiresIn, resendAfter }` (same for unknown numbers)                       |
| ✅ POST             | `/auth/otp/verify`                                  | public                               | `{ phone, code, deviceId? }` → AuthTokens (+ `isNewUser`); staff → 403                            |
| ✅ POST             | `/auth/admin/login`                                 | public · 10/15 min per identifier    | `{ identifier, password, deviceId? }` → AuthTokens \| `mfa_required` \| `mfa_enrollment_required` |
| ✅ POST             | `/auth/mfa/verify`                                  | public (challenge)                   | `{ challengeId, code \| recoveryCode }` → AuthTokens                                              |
| ✅ POST             | `/auth/refresh`                                     | public · 60/min per IP               | `{ refreshToken }` → new AuthTokens (rotation; reuse revokes family)                              |
| ✅ POST             | `/auth/logout` · `/auth/logout-all`                 | bearer                               | → 204 · `{ revokedSessions }`                                                                     |
| ✅ POST             | `/auth/password/forgot` · `/auth/password/reset`    | public · 3/h                         | `{ identifier }` → `{ sent }` · `{ identifier, code, newPassword }` → 204                         |
| ✅ POST             | `/auth/password/change`                             | bearer                               | `{ currentPassword, newPassword }` → 204 (other sessions end)                                     |
| ✅ POST             | `/auth/invitations/accept`                          | public · 10/h per email, 30/h per IP | `{ email, code, newPassword }` → 204; same answer for an unknown email (invite-only staff, D-56)  |
| ✅ GET              | `/me` · `/me/sessions` · DELETE `/me/sessions/{id}` | bearer                               | profile + roles + permissions + MFA · sessions                                                    |
| ✅ POST/DELETE      | `/me/mfa/totp/enroll` · `/confirm` · `/me/mfa/totp` | bearer (enrolment token OK)          | secret + otpauth URL · recovery codes (+ tokens) · 204                                            |
| ✅ GET/POST         | `/admin/users`                                      | users.view / users.invite            | list (cursor, q, status, userType) · create (temp password, roles[])                              |
| ✅ GET/PATCH/DELETE | `/admin/users/{id}`                                 | users.view / update / suspend        | detail · update · soft delete                                                                     |
| ✅ PUT              | `/admin/users/{id}/roles`                           | roles.assign                         | `{ roles: [{ roleKey, scopeType, scopeId? }], reason }` (full set, diff)                          |
| ✅ POST             | `/admin/users/{id}/block` · `/unblock`              | users.suspend                        | `{ reason }` → user (block ends sessions)                                                         |
| ✅ PATCH            | `/admin/users/{id}/status`                          | users.suspend                        | `{ status, reason }`                                                                              |
| ✅ GET              | `/admin/users/{id}/sessions`                        | users.sessions_view                  | live sessions                                                                                     |
| ✅ POST             | `/admin/users/{id}/force-logout`                    | users.sessions_revoke                | `{ reason }` → `{ revokedSessions, accessTokensBlocked }`                                         |
| ✅ GET/POST         | `/admin/roles`                                      | roles.view / roles.create            | list (cursor, q, audience) · create (key, audience, permissions[])                                |
| ✅ GET/PATCH        | `/admin/roles/{id}`                                 | roles.view / roles.update            | detail · name/description/MFA/idle (system role locked)                                           |
| ✅ POST             | `/admin/roles/{id}/archive`                         | roles.archive                        | `{ reason }`                                                                                      |
| ✅ PUT              | `/admin/roles/{id}/permissions`                     | roles.update                         | `{ permissions[], reason }` (full set; Super-Admin-only keys refused)                             |
| ✅ GET              | `/admin/roles/{id}/usage`                           | roles.view                           | staff count + scopes / warehouses holding the role (shown before a template edit, D-56)           |
| ✅ GET              | `/admin/permissions`                                | permissions.view                     | fixed catalog grouped by module (read-only)                                                       |
| ✅ GET              | `/admin/audit-logs`                                 | audit_logs.view                      | filters: actor, subject, target, action, from/to                                                  |
| GET                 | `/admin/users/{id}/devices` · `/auth-events`        | users.devices_view                   | planned: device list, block device, auth history                                                  |

**Internal (service token, never routed; D-56):** `POST /internal/staff/invitations` (+ `/resend`, `/assignments/revoke`),
`GET /internal/access/scope-members`, `GET /internal/access/warehouse-roles`, `POST /internal/users/contacts` (≤ 100 ids);
`/internal/access/{userId}/permissions` also returns `warehouses: { <warehouseId>: perms[] }` (WAREHOUSE-scoped grants).

**Tokens:** access = EdDSA JWT 15 min (`sub, sid, jti, typ, roles, scope`); refresh = opaque 256-bit, SHA-256 in `sessions`, rotated.
**Data (built):** `users`, `credentials`, `password_history`, `mfa_factors`, `mfa_recovery_codes`, `user_devices`, `auth_events`,
`roles`, `permissions`, `role_permissions`, `user_roles`, `sessions`, `admin_audit_log`. Redis: OTPs, MFA challenges, rate limits,
`revoked:jti`, `revoked:sid`, cached access (`perms:<userId>` + global RBAC version).

## 1b. Media (media-service) — ✅ built

| Method  | Path                              | Auth                          | Request → Response               |
| ------- | --------------------------------- | ----------------------------- | -------------------------------- |
| ✅ POST | `/v1/upload` (service: `/upload`) | bearer · 30 / 10 min per user | multipart `file` (+ `?type=image | video | document`) → 201 `{ url, key, kind, contentType, size, originalSize, width?, height?, durationSeconds? }` |

Images (JPEG/PNG/WebP ≤5 MB) → WebP q80 ≤1920×1080 · videos (MP4 ≤50 MB) → H.264/AAC ≤1080p · PDF (≤10 MB) unchanged.
Stored at `<BUCKET_FOLDER_PATH>/<uuidv7>.<ext>`, `public-read`. No database table yet (callers store the returned `url`/`key`).
Private uploads: `?purpose=support` (folder `support/`, D-55) or `?purpose=staff_document` (folder `staff/`, D-56) → not public; the
response carries an HMAC-signed `receipt` the consuming service verifies locally (each checks its own `purpose`); files are read
only through 5-minute signed URLs (`/internal/media/sign-read`).

## 2. Party: customers, farms, KYC, vendors

**Addresses + wishlist: ✅ built in user-service** (port 3006, customer-only, own records only).

- **Addresses:** `/v1/me/addresses` (list, get, create, update, delete, `POST /{id}/default`). Max 20 per customer, exactly one default, soft delete, audited in `user_audit_log`.
- **Wishlist:** `/v1/me/wishlist` (cursor list, `/ids`, add, remove, clear). The add is idempotent (201 new / 200 already saved), max 200 products, validated against product-service.
- **Support (read-only, `customers.view`):** `/v1/admin/customers/{userId}/addresses`, `…/addresses/{id}/history` and `…/wishlist`.
- **Order-service:** copies `GET /internal/users/{userId}/addresses/{id}` (AddressSnapshotV1) into the order at checkout.

**Farms + KYC: 🟡 built in farm-service** (`/v1/farms/*`, `/v1/admin/farms/*`). The full route list,
fields and rules are in [implementation-plan/07-farm-service.md](../implementation-plan/07-farm-service.md)
and live Swagger at gateway `/api-docs` (one page for all services, D-29). Rows below that farm-service now covers are kept
for the remaining party scope (customers, delegates, vendors).

| Method    | Path                                                             | Role                    | Request → Response                                                            |
| --------- | ---------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| POST      | `/register`                                                      | PUB (OTP token)         | path (FARM, HATCHERY, FEED_MILL, B2C) + owner + unit fields → owner + Farm ID |
| GET/PATCH | `/me` · `/me/addresses` · `/me/consents`                         | CUS                     | profile, addresses, DPDP consents                                             |
| POST      | `/me/deletion-request`                                           | CUS                     | data-principal request                                                        |
| GET/POST  | `/farms` · GET/PATCH `/farms/{id}`                               | CUS*                    | units of the owner; profile (versioned)                                       |
| POST      | `/farms/{id}/delegates` · DELETE `.../{userId}`                  | CUS*                    | delegate with an order ceiling                                                |
| POST      | `/kyc/documents` (upload URL) · GET `/kyc/status`                | CUS / VND               | Aadhaar (masked), PAN, GSTIN, docs                                            |
| GET/POST  | `/admin/customers` · `/admin/farms` · `/admin/kyc/{id}/decision` | customers.view / verify | review queue, duplicates                                                      |
| POST      | `/field/registrations`                                           | P12 (customers.create)  | assisted registration with consent                                            |
| POST      | `/vendors/applications`                                          | PUB                     | onboarding application + documents                                            |
| GET/POST  | `/admin/vendors` · `/admin/vendors/{id}/decision`                | vendors.view / approve  | checklist, MCA/GST/CDSCO results                                              |
| GET/PATCH | `/vendor/me` · `/vendor/agreements` · `/vendor/terms`            | VND                     | profile, e-signed agreements, commercial terms                                |

## 3. Catalogue, pricing, promotions, search

**Categories: ✅ built in catalog-service.** Public routes: `/v1/catalog/categories`, `/{slug}` and
`/{slug}/subcategories`. Admin routes: `/v1/admin/catalog/categories` (list, tree, get, history,
create, update, move, reorder, delete). Details:
[implementation-plan/08-catalog-service.md](../implementation-plan/08-catalog-service.md).

**Brands: ✅ built in catalog-service.** Public routes: `GET /v1/catalog/brands` (`q`, `isFeatured`,
cursor) and `GET /v1/catalog/brands/{slugOrId}` (cache-first, ETag/304). Admin routes:
`/v1/admin/catalog/brands`: list, get, history, create, update, `PATCH /{id}/status`, delete (soft).
All admin routes require `catalogue.manage`. Model `Brand` (`brands`): name, slug and code are unique
among live rows. Products will later reference it through a plain indexed (D-21).

**Products: ✅ built in product-service (:3005).**

- **Storefront:**
  - `GET /v1/catalog/products`: full-text and typo-tolerant search. Filters: category subtree, brand, dosage form, species, route, flock stage (`flockStage`), disease (`diseaseId` / `diseaseSlug`), Rx, temperature class, in-stock, price and `attr.<key>`. Sorts: relevance, name, price, discount, newest.
  - `/{slugOrId}`, `/{slugOrId}/alternatives` and `/filters` (now also `flockStages` + `diseases` facets).
  - `GET /v1/catalog/lookups` (groups incl. `FLOCK_STAGE`).
  - `GET /v1/catalog/diseases`: Shop by Problem cards with storefront-visible product counts (D-51).
- **Admin** (`/v1/admin/catalog/products`):
  - With `catalogue.manage`: CRUD, variants (exactly one active default), media, flags, compliance dry-run, history, and `submit`.
  - With `catalogue.publish`: `approve`, `reject`, `suspend`, `reinstate` and `discontinue`. The approver must not be the submitter.
- **Admin master data:** `/v1/admin/catalog/lookups`, `/diseases`, `/product-attributes` and `/compliance-profiles`. Products take `diseaseIds` and `productionStages` (FLOCK_STAGE codes).
- **Projections:** selling price and stock are read-only, kept in sync from pricing and inventory events.
- **Tables:** `products`, `product_variants`, `product_ingredients`, `product_routes`, `product_species`, `product_media`, `product_lookups`, `diseases`, `product_diseases`, `category_attributes`, `product_compliance_profiles`, `variant_price_projections`, `variant_availability`, `product_reference_blocks`, `product_audit_log`.

**Reviews & ratings: ✅ built in product-service (D-49).**

- **Storefront** (public, cached + ETag): `GET /v1/catalog/products/{slugOrId}/reviews` (PUBLISHED, sort recent / helpful / rating_high / rating_low, `rating`, `withImages`, cursor) and `/{slugOrId}/rating-summary` (avg, count, 5★…1★ with %). Product cards / detail carry `rating { avg, count }`; list adds `sort=rating` and `minRating`.
- **Customer** (`CUSTOMER`, own only): `POST /v1/catalog/products/{slugOrId}/reviews` (delivered + window, Idempotency-Key, 10/h); `/v1/catalog/reviews`: `GET /pending`, `GET /me`, `GET /votes`, `PATCH /{id}` (If-Match, ≤ 5 edits), `DELETE /{id}`, `PUT|DELETE /{id}/helpful`, `POST /{id}/reports`.
- **Admin** (`/v1/admin/catalog/reviews`, `reviews.view` / `reviews.moderate`): list + full-text search + filters, `/{id}`, `/{id}/history`, `POST /{id}/approve|reject|hide|restore`, `POST /bulk-status`, `GET /reports`, `POST /reports/{id}/resolve`, `GET /products/{productId}/summary`, `GET /analytics`.
- **Tables:** `product_reviews`, `review_eligibilities`, `review_votes`, `review_reports`, `product_rating_summaries`; `products.ratingAvg` / `ratingCount`.

**Offers, coupons & promotions: 🟡 Step 1 built in order-service (:3007, D-31).**

- **Customer** (`CUSTOMER`, own ACTIVE farm, 60/min): `POST /v1/orders/offers` (applied / alsoEligible / bundles / nudges / ineligible) and `POST /v1/orders/preview` (per-line price trace + invoice: item subtotal, savings, freight, GST by HSN, CGST/SGST or IGST, final payable). Advisory: limits are re-checked at checkout.
- **Admin** (`/v1/admin/promotions`): list / get with `pricing.view`; create (DRAFT), PATCH (`version` required; benefit fields locked once live), `POST /{id}/status` (DRAFT → ACTIVE | ARCHIVED, ACTIVE ↔ PAUSED, → ARCHIVED; activation re-validates + overlap check) with `pricing.manage`; `GET /{id}/redemptions` with `pricing.view`.
- **Kinds:** LINE_OFFER (FLAT per unit, PERCENTAGE + cap, COMBO buy X get Y, BUNDLE_PAIR set price), ORDER_COUPON (one per order), AUTO_BONUS (one, auto), SHIPPING. Rules: account type (B2B GST / retail), production type, farm category, new / existing farm, state / territory / pin, payment method / bank / card BIN, members only, limits (total, per farm, per user).
- **Tables:** `promotions`, `promotion_targets`, `promotion_rule_values`, `promo_redemptions`, `promo_redemption_items` (written by checkout, later), `order_variant_projections`, `order_farm_projections`, `order_audit_log`.
- **Public offers:** `GET /v1/orders/offers/public` (no login, only `isPublic` promotions, Redis 60 s + ETag).
- **Next:** Cart, then Orders / Checkout (row-locked promotions, conditional `usedCount` increment, order snapshots, pro-rata reversal).

| Method     | Path                                                                   | Role                      | Request → Response                                                |
| ---------- | ---------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| GET        | `/catalog/categories` · `/catalog/products` · `/catalog/products/{id}` | PUB / CUS                 | browse; product + variants, tiers, stock, ETA, flags              |
| GET        | `/catalog/search?q=`                                                   | PUB / CUS                 | brand, molecule, Telugu, misspellings; sponsored results labelled |
| POST       | `/pricing/resolve`                                                     | CUS / system              | `{ lines, farmId }` → resolved price + **full trace**             |
| POST/PATCH | `/admin/products` · `/admin/products/{id}`                             | catalogue.create / update | draft items, variants, attributes, documents                      |
| POST       | `/admin/products/import`                                               | catalogue.create          | spreadsheet → validation report                                   |
| POST       | `/admin/products/{id}/publish` · `/suspend`                            | catalogue.publish         | lifecycle transitions                                             |
| GET/POST   | `/vendor/items/verification` · `/vendor/items/{id}/corrections`        | VND                       | verify or correct (itemised)                                      |
| POST/GET   | `/admin/price-tiers` · `/admin/price-tiers/{id}/approve`               | pricing.manage / approve  | effective-dated versions                                          |
| POST       | `/admin/price-overrides`                                               | pricing.override (P8)     | reason + second approver above threshold                          |
| CRUD       | `/admin/coupons` · `/admin/campaigns` · `/admin/combos`                | pricing.manage            | rules, caps, validity                                             |

## 4. Cart, checkout, orders, returns, recurring

> **Approved design (2026-11-20, D-34…D-45): [`oms/05-api.md`](oms/05-api.md) supersedes the order and
> checkout rows below** (admin-confirmed orders, `POST /v1/orders/checkout`, `/v1/admin/orders/*`). Rows
> for returns, recurring orders and quotations remain the long-term plan.

| Method              | Path                                                                                         | Role                            | Request → Response                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| GET/POST/PUT/DELETE | `/cart` · `/cart/items` · `/cart/items/{variantId}` · `/cart/merge` · `/cart/refresh-prices` | CUS                             | revalidated cart with price trace                                          |
| PUT/DELETE          | `/cart/coupon` · GET `/offers`                                                               | CUS                             | applied and unapplied benefits                                             |
| POST                | `/checkout`                                                                                  | CUS                             | `{ farmId, addressId, gstin? }` → order (Payment Pending) + payment intent |
| GET                 | `/orders` · `/orders/{id}` · `/orders/{id}/tracking` · `/orders/{id}/invoices`               | CUS*                            | status history, shipments, COA links                                       |
| POST                | `/orders/{id}/cancel`                                                                        | CUS* (before picking)           | `{ reason }`                                                               |
| POST/GET            | `/returns` · `/returns/{id}`                                                                 | CUS*                            | reason + evidence → return                                                 |
| CRUD                | `/recurring-orders` · POST `.../{id}/skip`                                                   | CUS*                            | schedules                                                                  |
| POST                | `/quotations` · `/quotations/{id}/convert`                                                   | P12, CUS                        | tonnage and equipment (S)                                                  |
| GET/PATCH           | `/admin/orders` · `/admin/orders/{id}`                                                       | orders.view / update            | search by any attribute                                                    |
| POST                | `/admin/orders/{id}/cancel` · `/admin/returns/{id}/decision`                                 | orders.cancel / returns.approve | reason required                                                            |
| POST                | `/field/orders`                                                                              | P12 (orders.create)             | assisted order at the published price + customer OTP                       |

## 5. Payments, settlement, finance

> **payment-service :3009 (D-37): see [`oms/05-api.md`](oms/05-api.md)** for payments, verify, webhooks,
> refunds and mock APIs. Settlement, wallet and NEFT rows below are deferred (D-42).

| Method   | Path                                                           | Role                       | Request → Response                                        |
| -------- | -------------------------------------------------------------- | -------------------------- | --------------------------------------------------------- |
| POST     | `/payments/{orderId}/intent` · `/payments/{id}/retry`          | CUS*                       | Razorpay order / link / QR; NEFT reference for high value |
| POST     | `/webhooks/razorpay` · `/webhooks/razorpayx`                   | gateway (signature)        | idempotent event processing                               |
| GET      | `/payments/{id}`                                               | CUS*                       | status                                                    |
| POST     | `/admin/refunds` · `/admin/refunds/{id}/approve`               | refunds.initiate / approve | to source or bank                                         |
| GET/POST | `/admin/settlements` · `/admin/payout-batches/{id}/release`    | settlements.view / approve | daily run, dual control                                   |
| POST     | `/admin/settlements/{id}/reverse`                              | settlements.reverse (P8)   |                                                           |
| GET      | `/vendor/settlements` · `/vendor/statement` · `/vendor/ledger` | VND                        | statement and ledger                                      |
| GET      | `/admin/reconciliation` · `/admin/exposure`                    | payments.reconcile         | exceptions, settlement exposure                           |
| GET      | `/wallet` · POST `/wallet/topups`                              | CUS / VND (ad wallet)      | ledger                                                    |

## 6. Clinical: consultations and prescriptions

| Method   | Path                                                                 | Role                       | Request → Response                        |
| -------- | -------------------------------------------------------------------- | -------------------------- | ----------------------------------------- |
| GET      | `/vets/availability`                                                 | CUS                        | slots (language, territory)               |
| POST/GET | `/consultations` · `/consultations/{id}`                             | CUS / VET                  | booking; attachments; notes               |
| POST     | `/consultations/{id}/prescriptions`                                  | VET (prescriptions.manage) | items, dose, withdrawal → Rx (signed PDF) |
| GET      | `/prescriptions` · `/prescriptions/{id}` · `/prescriptions/{id}/pdf` | CUS* / VET                 | per Farm ID                               |
| POST     | `/prescriptions/{id}/add-to-cart`                                    | CUS*                       | all items at the prescribed quantity      |
| GET      | `/farms/{id}/withdrawal-tracker`                                     | CUS*                       | safe dates                                |
| POST     | `/lab/samples` · GET `/lab/results`                                  | VET / CUS*                 | accession number                          |

## 7. Leads, ads, liquidation, loyalty, content, support, notifications

| Method    | Path                                                                                                                 | Role                                                         | Request → Response                       |
| --------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| GET/POST  | `/leads/slots` · `/leads`                                                                                            | CUS                                                          | slot + question + consent → scored lead  |
| GET/PATCH | `/vendor/leads` · `/vendor/leads/{id}/disposition`                                                                   | VND (own)                                                    | SLA timers, masked call                  |
| GET/POST  | `/vendor/ads/fares` · `/vendor/ads/bookings` · `/vendor/creatives`                                                   | VND                                                          | 15-minute hold, payment, creative        |
| POST      | `/admin/ads/bookings/{id}/authorize` · `/admin/creatives/{id}/validate`                                              | ads (P18) / content (P19)                                    | different users                          |
| GET/POST  | `/vendor/liquidation/batches` · `/vendor/liquidation/programmes`                                                     | VND                                                          | within guardrails; else approval         |
| GET       | `/loyalty/me` · `/loyalty/points` · `/referrals`                                                                     | CUS                                                          | tier, points, benefits                   |
| GET       | ✅ `/farms/content/feed` · `/farms/content/{idOrSlug}` · `/admin/farms/content` (farm-service, D-50)                 | CUS / content.manage · review · publish                      | EN only, targeting by farm segment       |
| POST/GET  | ✅ `/support/tickets*` · `/support/chat/ws` · `/faqs` · `/legal/{kind}` · `/support/admin/*` (support-service, D-55) | CUS · VND · LOG · WH / support.* · faq.manage · legal.manage | priority + SLA, live chat, order context |
| GET/PATCH | `/me/notifications` · `/admin/notifications/templates`                                                               | CUS / notifications.manage                                   | inbox, templates                         |

## 8. Logistics, warehouse, QMS (from Logistics PRD §10)

| Method   | Path                                                                                | Role               | Purpose                                      |
| -------- | ----------------------------------------------------------------------------------- | ------------------ | -------------------------------------------- |
| POST     | `/auth/esign`                                                                       | WHS, QA            | fresh e-signature token for approvals        |
| GET/POST | `/me/shift/today` · `/shifts` · `/shifts/{id}/end`                                  | DRV                | shift, vehicle checklist, asset return       |
| POST     | `/sync/events`                                                                      | DRV, WHO           | offline event batches (idempotent)           |
| POST     | `/evidence/upload-url`                                                              | DRV, WHO           | signed URL; SHA-256 recorded                 |
| GET/POST | `/pick-lists?node=` · `/consignments/{id}/pick` · `/pack` · `/dispatch`             | WHO, WHS           | FEFO scan, pack/seal, dispatch checklist     |
| POST     | `/manifests/{id}/gate-scan` · `/trips` · `/trips/{id}/assign`                       | WHS, LOG           | manifest, driver/vehicle eligibility         |
| POST     | `/consignments/{id}/custody` · `/otp/resend` · `/otp/verify` · `/pod` · `/failures` | DRV                | custody, OTP, line receipt + photos, failure |
| POST     | `/exceptions/{id}/decision`                                                         | LOG                | approve fallback / redelivery / return       |
| POST     | `/telemetry` · `/loggers/{assetId}/files` · `/alerts/{id}/ack`                      | device / WHO / LOG | readings, excursions                         |
| POST     | `/holds` · `/deviations` · `/deviations/{id}/close`                                 | QA, QAM            | holds, CAPA                                  |
| GET/POST | `/trace/batch/{id}` · `/recalls`                                                    | QA, QAM            | forward/backward trace, recall               |
| GET      | `/kpis` · `/payouts/ledger` · `/audit`                                              | LOG, EXE           | KPIs, trip ledger                            |
| GET      | `/t/{signedToken}` · `/coa/{consignmentNo}`                                         | PUB                | tracking link, public COA verification       |
| CRUD     | `/admin/nodes` · `/admin/vehicles` · `/admin/drivers` · `/admin/assets`             | ADM, FLT           | masters, documents, calibration              |
| CRUD     | `/procurement/quotations` · `/purchase-orders` · `/receipts` · `/transfers`         | P7, P9/P10         | PO approval bands, GRN, 3-way match          |

## 8b. Warehouse portal (warehouse-service :3014) — ✅ built (D-56: Login + W2)

Gateway `/v1/admin/warehouses/*` and `/v1/admin/wms/*`. Staff tokens only; permissions `warehouse.view | configure | operate |
team_manage` (GLOBAL or one warehouse) and `warehouse.create | status_change` (GLOBAL). A warehouse outside the caller's
scope → 404. Screen → API map for the frontend: `docs/warehouse/README.md`.

| Method                   | Path (under `/admin/warehouses` unless noted)                                                                       | Permission                | Purpose                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| ✅ GET                   | `/admin/wms/me` · `/admin/wms/search?q`                                                                             | staff                     | switcher, sidebar `modules`, header search                                               |
| ✅ GET                   | `/` · `/summary` · `/export.csv` · `/code-availability` · `/lookups` · `/lookups/districts`                         | view / create             | W2.01 list + KPIs (stock, used kg, capacity %), CSV, wizard helpers                      |
| ✅ POST/GET/PATCH/DELETE | `/` · `/{id}`                                                                                                       | create / view / configure | SETUP draft, details (+ `stock`, `setup.steps`), edit (`expectedVersion`), discard draft |
| ✅ POST                  | `/{id}/activate` · `/limit` · `/deactivate` · `/reactivate`                                                         | status_change             | state machine; checklist (422); 409 `HAS_OPEN_ORDERS`                                    |
| ✅ CRUD                  | `/{id}/service-areas` (+ `/{areaId}/reassign`) · GET `/coverage/{pin}`                                              | view / configure          | W2.04 districts, PIN ranges, priority; imported PINs → district                          |
| ✅ CRUD                  | `/{id}/zones` · `/racks` · `/bins` · GET `/{id}/storage/layout`                                                     | view / configure          | W2.05 storage; bins within rack limits                                                   |
| ✅ CRUD                  | `/{id}/team` (+ `/resend-invite`, `/documents`) · GET `/team/roles`                                                 | view / team_manage        | W2.06 invite-only staff, documents, read-only roles panel                                |
| ✅ CRUD                  | `/{id}/dock-doors` · `/staging-areas` · `/yard-slots` · GET `/{id}/dock-yard`                                       | view / configure          | W2.07 setup + KPIs (capacity per unit)                                                   |
| ✅ POST                  | `/{id}/dock-doors/{doorId}/bookings` · `/{id}/dock-bookings/{id}/start\|complete\|cancel` · yard `/occupy\|release` | operate                   | bookings (no overlap, 409 `DOCK_BUSY`), yard moves                                       |
| ✅ GET/PUT/CRUD          | `/{id}/calendar` · `/operating-hours` · `/cutoffs` · `/shifts` · `/holidays`                                        | view / configure          | W2.09                                                                                    |
| ✅ CRUD                  | `/{id}/storage-rules` (+ `/summary`)                                                                                | view / configure          | W2.08, `NOT_ENFORCED` until put-away (W8)                                                |
| ✅ GET                   | `/{id}/overview` · `/{id}/stock-by-category` · `/{id}/orders?status`                                                | view                      | W2.03 cards, status board, stock tab, active orders                                      |

**Events:** publishes `warehouse.upserted.v1`, `warehouse.coverage_replaced.v1` (inventory keeps a projection); consumes order /
reservation events into the order read model. **Jobs:** BullMQ `refresh-stats` pulls inventory
`GET /internal/inventory/warehouse-stats` every minute.

## 8c. Warehouse portal W3 + W4 (warehouse-service) — ✅ built (D-57, 2026-11-24)

Same handlers on two audiences: `/v1/wms/*` (warehouse panel, the caller's warehouses; out of scope
→ 404) and `/v1/admin/wms/*` (admin panel, GLOBAL grants). Admin-only writes: routing rules /
fallback / throttles, lifecycle and restock approvals, compliance registry / inspectors, ATP
settings, cutover, ops. Customer `/v1/shipments/*` (own orders), 3PL `/v1/driver/trips/:token/*`.
Lists: `cursor` or `page` (offset ≤ 2,000; `meta.total` exact to 10,000); KPI widgets cached 20 s
(`fresh=true`). Full screen → API map: `docs/warehouse/README.md` (D-57 section).

| Area (Swagger tag "WMS Panel · …" / "WMS Admin · …") | Prefix                                                                                    | Screens                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------- |
| Stock, Lifecycle, Vendors, Cutover, Ops              | `/stock/*`, `/vendors/*`, `/ops/*`                                                        | W4.00–W4.11, interim inbound |
| Restock + transfers                                  | `/stock/restock-*`, `/stock/transfers/*`                                                  | W4.07, W4.08                 |
| Fulfilment, Floor, Exceptions, Delivery              | `/fulfilment/*`, `/sync-status`, `/exports/*`                                             | W3.01–W3.11                  |
| Routing rules                                        | `/routing/*`                                                                              | W3.12                        |
| Available-to-promise                                 | `/atp/*`                                                                                  | W3.13                        |
| Split, partial & backorder                           | `/fulfilment/orders/:id/split*`, `/fulfilment/backorders/*`, `/fulfilment/dispatch-slots` | W3.14                        |
| Order hold & edit                                    | `/fulfilment/orders/:id/hold*`, `/amendments*`, `/fulfilment/shipments/:id/manifest`      | W3.15                        |
| Compliance check                                     | `/compliance/*`                                                                           | W3.16                        |
| Payments (prepaid)                                   | `/payments-view/*`                                                                        | W3.18                        |
| Dispatch + Bulk                                      | `/dispatch/*`, `/bulk/*`                                                                  | W3.08, W3.19                 |

Other services (D-57): order-service `PATCH /v1/admin/orders/:id/delivery` and internal
`/internal/orders/:id/{fulfilment-facts, compliance-reject, shortage-refund, cancel-lines, delivery}`,
`/internal/orders/counts`; inventory internal `/internal/reservations/:id/reallocate`,
`/reservations-open-lines`, `/internal/inventory/{availability-settings, availability/resync, cutover/*}`;
payment-service internal `GET /internal/payments/stats`; auth internal `POST /internal/mfa/verify`.

## 8e. Gate & Weighbridge W5 (warehouse-service) — ✅ built (D-62, 2026-11-25)

Same two audiences as §8c: `/v1/wms/gate/*` (scoped) and `/v1/admin/wms/gate/*` (GLOBAL), 81 operations
each; setup `/v1/admin/warehouses/:id/{weigh-scales, gate-settings}` (6). Every write: `Idempotency-Key`
(24 h replay per user + route, different body → 422) + state guard; dashboard reads: ETag / 304 + Redis
cache keyed by the warehouse gate version and the minute bucket. Full screen → API map:
`docs/warehouse/README.md` (D-62 section).

| Area (Swagger "WMS Panel · Gate · …") | Prefix                                                                                                                                                                                   | Screens      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Dashboard & shipments                 | `/gate/{lookups, bays, purchase-orders, products, summary, status-mix, activity, shipments*}`, `/gate/documents/:docId/preview`                                                          | W5.01–W5.04  |
| Entries, documents & passes           | `/gate/arrivals`, `/gate/entries*`, `/gate/documents/:docId/verify`, `/gate/passes/*`                                                                                                    | W5.05–W5.08  |
| Weighbridge                           | `/gate/weighbridge/lookup`, `/gate/entries/:id/{weighments, reconciliation, hold*, outward-pass, exit, weighment-slip.pdf}`, `/gate/weighments/:id/*`, `/gate/approvals`, `/gate/scales` | W5.09, W5.10 |
| Dock appointments & ASN               | `/gate/appointments*`, `/gate/asns*`                                                                                                                                                     | W5.11, W5.12 |
| Visitors & security                   | `/gate/security/summary`, `/gate/visitors*`, `/gate/outward-materials*`, `/gate/security-checks*`                                                                                        | W5.13        |

Internal (hidden): `POST /internal/wms/gate/asns` (vendor portal / EDI, idempotent on vendor + ASN ref).
Changed: `POST /wms/stock/receipts` accepts `gateEntryId` + `finalForGate` (receipt always posts; link or
`warnings[GATE_LINK_SKIPPED]`). media-service private purpose `gate_document` (≤ 25 MB, TIFF allowed).
Tables (§9): `warehouse_inbound_shipments` (+ lines), `warehouse_gate_entries` (+ `…_entry_receipts`),
`warehouse_weigh_scales`, `warehouse_weighments`, `warehouse_gate_documents`, `warehouse_gate_passes`,
`warehouse_gate_events` (append-only), `warehouse_asns` (+ lines), `warehouse_gate_visitors`,
`warehouse_gate_outward_materials`, `warehouse_gate_security_checks`; `warehouse_dock_bookings` +
inboundShipmentId / vendorId / asnId / confirmedAt. Migration `20261225110000_warehouse_gate`.

## 8d. GST invoices + credit notes (order-service) — ✅ built (D-61, 2026-11-25)

One tax invoice (or bill of supply) per shipment, issued at gate-out **before** goods leave;
credit notes for short delivery and for invoices of shipments that never left (void). Money in
rupee strings; documents immutable (DB triggers); every byte served is integrity-checked.

| Method | Path                                                                  | Who                                                             | Notes                                                                                                                                    |
| ------ | --------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/orders/{id}/invoices`                                            | CUSTOMER (own; else empty list)                                 | documents oldest first, no snapshot JSON                                                                                                 |
| GET    | `/v1/orders/{id}/invoices/{docId}/download`                           | CUSTOMER (own; else 404), 30/min                                | `{url, expiresAt}` signed 5 min; 409 `PDF_NOT_READY` + `Retry-After: 5`                                                                  |
| GET    | `/v1/orders/{id}/invoices/combined`                                   | CUSTOMER (own; else 404), 10/min                                | `application/pdf`, ≤ 20 documents, cached per document set                                                                               |
| GET    | `/v1/admin/invoices`                                                  | `invoices.view`                                                 | q (exact doc / order no.), orderId, userId, farmId, docType, status, pdfStatus, b2b, from/to (IST); keyset                               |
| GET    | `/v1/admin/invoices/{id}`                                             | `invoices.view`                                                 | lines, snapshot, hash, PDF state, linked documents                                                                                       |
| GET    | `/v1/admin/invoices/{id}/download`                                    | `invoices.view` (audited)                                       | as the customer download                                                                                                                 |
| POST   | `/v1/admin/invoices/{id}/pdf/retry`                                   | `invoices.view` (reason, audited)                               | FAILED → PENDING only (409 `NOT_FAILED`)                                                                                                 |
| GET    | `/v1/admin/invoices/export.csv?from&to`                               | `invoices.export` (audited), 5/min                              | GST register, ≤ 31 days, streamed, CSV-injection safe                                                                                    |
| GET    | `/v1/wms/fulfilment/shipments/{id}/invoice.pdf` (+ `/v1/admin/wms/…`) | `fulfilment.view` in that warehouse (else 404), 30/min, audited | gate copy; 404 `NO_INVOICE` before gate-out                                                                                              |
| POST   | `/v1/wms/dispatch/trips/{id}/depart` (changed)                        | `logistics.dispatch_assign`                                     | issues invoices first; 409 `INVOICE_BLOCKED` / `INVOICE_STALE`, 503 `INVOICE_UNAVAILABLE`; response `invoices[]` with `ewayBillRequired` |

Internal (service token, never routed by the gateway, hidden from Swagger by rule):
`POST /internal/orders/{id}/shipments/{shipmentId}/invoice` (`{lines, linesHash, by}` →
`{docId, docNo, docType, grandTotal, grandTotalPaise, linesHash, replayed, voidedDocNo}`; 409
`INVOICE_INVALID` / `ALREADY_DISPATCHED` / `LINES_HASH_MISMATCH`) and
`GET /internal/orders/{id}/invoices/by-shipment/{shipmentId}/pdf` (bytes + `X-Document-No`).
`POST /internal/orders/{id}/shortage-refund` now also returns `creditNoteNo` and refunds exactly
the credit note total. Compliance checklist: `docs/invoices/gst-compliance.md`.

Future: move PDF rendering off the API event loop (worker thread pool or a separate renderer
process): each invoice costs ~15–20 ms CPU, which raises API latency during bulk dispatch or load.
See D-61.

## 9. DB models and relations

- **✅ Built (`packages/database/prisma/schema/auth/`):**
  - `users`, `credentials`, `password_history`, `mfa_factors`, `mfa_recovery_codes`;
  - `user_devices`, `auth_events`;
  - `roles`, `permissions`, `role_permissions`, `user_roles` (scoped);
  - `sessions`, `admin_audit_log`, `outbox_events`, `processed_events`.
- **✅ Built (`packages/database/prisma/schema/warehouse/`, D-56):**
  - `warehouse_warehouses` (one live MOTHER, trigram search, `reviewFields`), `warehouse_status_events`,
    `warehouse_audit_log` (append-only);
  - `warehouse_service_areas` 1–N `warehouse_service_area_pins` (DISTRICT / IMPORTED areas, priority ranks);
  - `warehouse_zones` 1–N `warehouse_racks` 1–N `warehouse_bins`;
  - `warehouse_dock_doors` 1–N `warehouse_dock_bookings` (exclusion constraint: no overlap per door),
    `warehouse_staging_areas`, `warehouse_yard_slots`;
  - `warehouse_operating_hours`, `warehouse_shifts`, `warehouse_holidays`, `warehouse_cutoffs`, `warehouse_storage_rules`;
  - `warehouse_staff_profiles`, `warehouse_staff_documents` (roles stay in auth);
  - read models: `warehouse_stock_current`, `warehouse_stock_by_category`, `warehouse_daily_stats`,
    `warehouse_order_headers`, `warehouse_order_allocations`;
  - inventory keeps `inventory_warehouses` + coverage as a projection (same ids); its variant projection adds
    `rootCategoryId` + `weightGrams`; `inventory_stock_ledger` has a BRIN index on `createdAt`.
- **Party:**
  - `Owner` 1–N `FarmUnit` (immutable `farmId`, `territoryId`, `productionTypes[]`, versioned
    `FarmProfile`);
  - `User`↔`Owner`: owner users and delegates (`parentUserId`);
  - `KycDocument` (masked Aadhaar reference only);
  - `Territory` (district → mandal → pin) ↔ `Node` (primary/alternate per pin).
- **Vendor:** `Vendor` 1–N `VendorUser`, `Certification` (validity), `Agreement`, `CommercialTerm`
  (per item, effective-dated), `AdWallet` + `WalletLedger`, `LiquidationGuardrail`.
- **Catalogue:**
  - `Category` tree; `Item` (vendorId) 1–N `Variant` (pack size, HSN, GST, Rx/cold flags,
    withdrawal periods);
  - `ItemDocument`, `ItemVersion`/`ChangeLog`;
  - `PriceTierTable` (variantId, effective-dated version) 1–N `PriceTier`;
  - `B2CPrice`, `Coupon`, `Campaign`, `Combo`, `ClearanceEvent`.
- **Orders:**
  - `Cart` 1–N `CartLine`;
  - `Order` (ownerId, farmUnitId, priceVersion, attribution) 1–N `OrderLine` (full price trace
    JSON);
  - `Order` 1–N `Shipment` (node); `OrderStatusEvent`; `Return` 1–N `ReturnLine`;
  - `RecurringSchedule`, `Quotation`.
- **Payments:**
  - `Payment` (orderId, gateway ref, state), `Refund`;
  - `Invoice` (IRN), `CreditNote` / `DebitNote`;
  - `Settlement` (vendorId, units) → `PayoutBatch`; `VendorLedgerEntry`; `CustomerWallet`.
- **Clinical:**
  - `Veterinarian` (council registration and expiry);
  - `Consultation` (farmUnitId) 1–N `ClinicalNote`;
  - `Prescription` (farmUnitId, vetId, state, validity) 1–N `RxItem` (dispensedQty, withdrawal);
  - `LabSample` (accession), `LabResult`.
- **Supply:**
  - `PurchaseOrder` 1–N `POLine`;
  - `Consignment` (inbound, from PO) 1–N `Batch` (mfg/expiry/receipt) 1–N `InventoryUnit` (QR,
    state);
  - `Location` (node → aisle → rack → shelf → pallet → bin, temperature zone); `StockMovement`;
  - `Transfer`; `QuarantineRecord`; `Coa` (consignment/batch, source: manufacturer or Interferon).
- **Logistics:**
  - `Consignment` (outbound shipment, state machine) 1–N `ConsignmentLine`, `CustodyEvent`,
    `PodRecord`, `EvidenceFile`, `Exception`;
  - `Trip` 1–N `TripStop`;
  - `Driver`, `Vehicle` (+ documents), `Shipper`/`Asset`, `CalibrationRecord`;
  - `TemperatureReading` (time series), `Excursion`, `AlertEpisode`;
  - `QualityHold`, `Deviation` → `Capa`, `Recall` 1–N `RecallItem`; `TripLedger`.
- **Growth:**
  - `Lead` (farmUnitId, vendorId, productId, score, consent, calls, disposition, attributedOrderId);
  - `AdBooking` 1–N `SlotDay` (fare snapshot), `Creative` (versions, review);
  - `LiquidationProgramme` (batches, territories, window);
  - `LoyaltyTier`, `PointsLedger`, `Referral`, `ContentItem`;
  - `Ticket` 1–N `TicketMessage`; `NotificationLog`.
- **Rules:**
  - each model belongs to one feature; cross-feature references are plain uuid columns;
  - money is `Decimal(14,2)`; every state change has a timestamp, an actor and a reason;
  - audit tables are append-only.
