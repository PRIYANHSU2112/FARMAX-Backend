# OMS 05 — APIs

Common rules:

- Responses use the shared envelope; inputs are validated with Joi (422 + `details.issues`).
- Swagger is served only at gateway `/api-docs`.
- **Customer** routes: CUSTOMER with full scope; orders of the caller's own `userId` (and farms they own)
  only. Any other id answers **404**.
- **Admin** routes: INTERNAL + MFA + permission (default deny); writes are limited to 60 per minute;
  sensitive writes need a reason and an audit row.
- `Idempotency-Key` (8–64 chars) is **required** where marked; the key and a request hash are stored
  in the DB, so a replay returns the original response and the same key with a different body gives 422.

## order-service — customer (`/v1/orders`, already routed)

| Method & path                                                  | Idem. | Limit  | Notes                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/orders/checkout`                                     | ✔     | 10/min | `{farmId, addressId, cartVersion, billToGst, couponCode?}` → 201 `{order, payment:{paymentId, provider, keyId, providerOrderId, amount}}`. Errors: 409 CART_CHANGED, 409 INSUFFICIENT_STOCK (per line), 422 RX_REQUIRED, 422 NOT_SERVICEABLE, 503 retry with the same key |
| `GET /v1/orders?tab=active\|completed\|cancelled&cursor&limit` |       |        | Lean rows: orderNo, placedAt, item count, grandTotal, the four status columns, `paymentDueAt`                                                                                                                                                                             |
| `GET /v1/orders/{id}`                                          |       |        | Lines, totals, address, statuses, `timeline[]`, refunds (requested vs completed), `actions` (`pay`, `cancel`, each with `allowed` + `reason`)                                                                                                                             |
| `POST /v1/orders/{id}/pay`                                     |       | 20/min | New attempt while paymentStatus is PENDING or FAILED and before `paymentDueAt` → payment details                                                                                                                                                                          |
| `POST /v1/orders/{id}/cancellation-quote`                      |       | 20/min | `{lines?}` → `{eligible, reason?, freeWindowEndsAt, fee, refundAmount, lines}`                                                                                                                                                                                            |
| `POST /v1/orders/{id}/cancel`                                  | ✔     | 10/min | `{lines?, reasonCode (ORDERED_BY_MISTAKE · FLOCK_DELAYED · LOWER_PRICE · VET_ADVISED · OTHER), note?}`                                                                                                                                                                    |

## order-service — manager / admin (`/v1/admin/orders`, new gateway prefix)

| Method & path                                              | Permission                                   | Notes                                                                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/admin/orders`                                     | `orders.view`                                | Filters: status, paymentStatus, stockStatus, refundStatus, orderNo, farmId, userId, warehouseId, placedFrom/To, amount range, overdue; sort; cursor |
| `GET /v1/admin/orders/review-queue`                        | `orders.view`                                | PENDING_ADMIN_CONFIRMATION + PAID + COMMITTED, oldest first, SLA age, overdue flag                                                                  |
| `GET /v1/admin/orders/stats`                               | `orders.view`                                | Counts per status, awaiting review, overdue, today's numbers, GMV (Redis 30 s)                                                                      |
| `GET /v1/admin/orders/exceptions?type=`                    | `orders.view`                                | `refund_failed` · `stock_release_pending` · `amount_mismatch` · `late_payment`                                                                      |
| `GET /v1/admin/orders/{id}`                                | `orders.view`                                | Full detail, allocations, payment summary, refunds (both lifecycles), notes                                                                         |
| `POST /v1/admin/orders/{id}/confirm`                       | **`orders.confirm`** (new)                   | `{expectedVersion, note?}`                                                                                                                          |
| `POST /v1/admin/orders/{id}/reject`                        | `orders.confirm`                             | `{expectedVersion, reasonCode (OUT_OF_STOCK_PHYSICAL · PRICE_ERROR · SUSPECTED_FRAUD · NOT_SERVICEABLE · RX_INVALID · OTHER), reason}`              |
| `POST /v1/admin/orders/bulk-confirm`                       | `orders.confirm`                             | `{orderIds ≤ maxBulkConfirm}` → result per order (one transaction each)                                                                             |
| `POST /v1/admin/orders/{id}/cancel`                        | `orders.cancel` (sensitive)                  | `{expectedVersion, lines?, reasonCode, reason}`                                                                                                     |
| `GET` / `POST /v1/admin/orders/{id}/notes`                 | `orders.view` / `orders.update`              | Internal notes                                                                                                                                      |
| `POST /v1/admin/orders/{id}/refunds/{rid}/retry`           | `refunds.initiate`                           | FAILED → RETRY_REQUESTED (same `sourceRef`)                                                                                                         |
| `POST /v1/admin/orders/{id}/refunds/{rid}/resolve-offline` | `refunds.approve` (SoD)                      | `{reason, bankReference}` → MANUALLY_RESOLVED                                                                                                       |
| `GET` / `PATCH /v1/admin/orders/settings`                  | `orders.view` / **`orders.configure`** (new) | Payment window, grace, SLA, auto-reject, cancellation policy                                                                                        |

> Built 2026-11-24. The staff detail `GET /v1/admin/orders/{id}` carries the full `history` (who did what), `refunds` and `notes`, so there are no separate timeline / refunds endpoints. Staff also get `POST /v1/admin/orders/{id}/cancellation-quote` (no fee for staff cancellations).

## order-service — internal (never routed)

- `GET /internal/orders/{id}`: for future logistics and invoice services.
- `GET /internal/orders/status?ids=`: for the inventory orphan sweep.

## payment-service (`/v1/payments`, `/v1/webhooks`, `/v1/admin/payments`, `/v1/admin/refunds`)

| Method & path                                        | Auth                                                            | Notes                                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/payments/{id}`                              | owner                                                           | "Check Status Now"                                                                                                                                                  |
| `POST /v1/payments/{id}/verify`                      | owner, 20/min (idempotent by gateway payment id; no key needed) | `{providerOrderId, providerPaymentId, signature}` → HMAC-SHA256 (constant time) → gateway fetch (amount and status) → CAPTURED                                      |
| `POST /v1/webhooks/razorpay`                         | public, signature                                               | `X-Razorpay-Signature` over the **raw body**; dedup on `eventId`; store, enqueue, respond 200 in milliseconds; 64 KB limit                                          |
| `POST /v1/payments/{id}/mock/succeed` · `/mock/fail` | owner, **mock only**                                            | Registered only when `PAYMENT_PROVIDER=mock`; config refuses mock when `APP_ENV=prod`. Produces correctly signed payloads, so the real verify and webhook code runs |
| `GET /v1/admin/payments`, `/{id}`                    | `payments.view`                                                 | With attempts and webhook log                                                                                                                                       |
| `POST /v1/admin/payments/{id}/reconcile`             | `payments.reconcile`                                            | Refetch from the gateway                                                                                                                                            |
| `GET /v1/admin/refunds`                              | `payments.view`                                                 |                                                                                                                                                                     |
| `POST /v1/admin/refunds/{id}/approve`                | `refunds.approve` (SoD)                                         | Only PENDING_APPROVAL                                                                                                                                               |
| `POST /v1/admin/refunds/{id}/retry`                  | `refunds.initiate`                                              | FAILED_FINAL → RETRYING                                                                                                                                             |

Internal routes (service token):

| Route                                     | Notes                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /internal/payments`                 | `{orderId, orderNo, userId, amountPaise, currency, expiresAt}`; idempotent per order (one live payment; "pay again" reuses it and its gateway order) |
| `GET /internal/payments/{id}`             | Payment view                                                                                                                                         |
| `POST /internal/payments/{id}/cancel`     | Void the intent                                                                                                                                      |
| `GET /internal/payments/{id}/live-status` | Gateway refetch                                                                                                                                      |

## inventory-service additions (P1)

`GET /internal/inventory/reservations?orderRef=`: lookup used by the R2 recovery path.

## Permissions

- **New** in `auth-service/.../permissions.catalog.ts`: `orders.confirm` (GLOBAL/REGION, sensitive) and
  `orders.configure` (GLOBAL, sensitive). Run `pnpm db:seed` after adding them.
- **Reused:** `orders.view`, `orders.update`, `orders.cancel`, `payments.view`, `payments.reconcile`,
  `refunds.initiate`, `refunds.approve`.
- **F1:** `shipments.view`, `shipments.update`, `delivery.verify`.
