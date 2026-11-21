# Event Contracts

_Last updated: 2026-11-11._ Events carry **facts** between services over RabbitMQ. Inside a service,
modules call each other's services directly; jobs inside a service use BullMQ.

**Status:** the contracts and the envelope are defined in code. The outbox relay, publisher,
consumers and inbox are not built yet (Phase 2), so **nothing is published today**.

| Code                                                                                                          | What                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`packages/infra/src/events/envelope.ts`](../packages/infra/src/events/envelope.ts)                           | `EventEnvelope<Type, Data>`, `EVENT_TYPE_PATTERN`                       |
| [`packages/infra/src/events/contracts/auth.events.ts`](../packages/infra/src/events/contracts/auth.events.ts) | auth-service contracts (`AUTH_EVENTS`, payload types, `AuthEventMap`)   |
| `services/*/prisma/schema/outbox.prisma`                                                                      | `outbox_events` (producer side) and `processed_events` (consumer inbox) |

## Envelope

```ts
interface EventEnvelope<TType, TData> {
  id: string; // UUID v7 = outbox row id = inbox de-dup key
  type: TType; // routing key, e.g. "user.registered.v1"
  version: number; // the N in .vN
  occurredAt: string; // ISO-8601, producer commit time
  source: string; // "auth-service"
  correlationId: string; // originating request id, carried through every hop
  causationId?: string; // event that caused this one
  data: TData;
}
```

## Delivery

```mermaid
sequenceDiagram
  autonumber
  participant S as Producer service
  participant DB as Producer DB
  participant X as RabbitMQ events (topic)
  participant Q as Consumer queue
  participant C as Consumer service
  S->>DB: BEGIN · business write · INSERT outbox_events · COMMIT
  loop outbox relay
    S->>DB: read unpublished rows
    S->>X: publish (confirm mode, routing key = type)
    S->>DB: set publishedAt
  end
  X->>Q: bind by routing key
  Q->>C: deliver (prefetch 20)
  C->>C: BEGIN · INSERT processed_events (id, consumer) · handle · COMMIT
  C-->>Q: ack after commit (duplicate id → skip + ack)
```

- **At-least-once.** The producer may publish an event twice, and the consumer inbox makes
  handling idempotent.
- **Failures.** Implemented today (`@farmx/infra/rabbitmq`): a failed delivery is re-queued with an
  `x-farmx-attempts` header, up to 5 attempts, then dead-lettered to `<queue>.dlq` (bound on
  `events.dlx`). A malformed envelope goes straight to the DLQ. Delayed retry queues (`.5s`, `.30s`,
  `.5m`) are a later refinement. The relay retries an outbox row up to 10 times (`attempts`, `lastError`).
- **Ordering** is not guaranteed across events. Consumers use `occurredAt` and the current state,
  never the arrival order.
- **Names.**
  - Exchange: `events` (topic). Retry exchange: `events.retry`. Dead-letter exchange: `events.dlx`.
  - Routing key: `<aggregate>.<event>.v<N>`.
  - Consumer queue: `<consumer-service>.<purpose>`, for example `notification.auth-events`.

## Rules

1. **The producer owns the contract.** It lives in `@farmx/infra/events/contracts/<producer>.events.ts`.
   Consumers import the types and never import producer code.
2. **Published contracts are never edited.** A breaking change becomes a new `.v(N+1)` type. Publish
   both versions until every consumer has moved, then retire the old one. Adding an optional field
   is the only non-breaking change.
3. **No secrets.** Never put passwords, hashes, OTP codes, tokens or keys in an event.
4. **Minimal personal data.** Include personal data only when a consumer needs it to act. Consumers
   must handle `user.deleted.v1` by deleting or anonymising their copy (DPDP).
5. **Facts, not commands.** Events are named in the past tense. To ask another service to do
   something, use internal HTTP.

## Catalog

### Published by auth-service

| Type                          | When                                                         | Payload (`data`)                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `user.registered.v1`          | A user account is created by any channel                     | `userId`, `userType`, `fullName`, `email \| null`, `phone \| null`, `preferredLanguage`, `registrationSource`, `parentUserId \| null` |
| `user.status_changed.v1`      | Activation, suspension, deactivation or lock                 | `userId`, `previousStatus`, `status`, `changedByUserId \| null`                                                                       |
| `user.deleted.v1`             | Soft delete by an admin                                      | `userId`, `deletedByUserId \| null`                                                                                                   |
| `auth.session_compromised.v1` | Refresh-token reuse detected; the session family was revoked | `userId`, `familyId`, `revokedSessions`, `ip \| null`, `deviceId \| null`                                                             |

Consumers: none yet (auth-service has **no outbox relay**, so these are not published). The notification service will add welcome / account / security rules once they are (docs/notifications). Other expected consumers:
and services that keep a local read model of users.

### Published by farm-service

Contracts: [`contracts/farm.events.ts`](../packages/infra/src/events/contracts/farm.events.ts).
Rows are written to `outbox_events` in the same transaction (relay pending, Phase 2).

| Type                        | When                                   | Payload (`data`)                                                                                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `farm.submitted.v1`         | Registration submitted or resubmitted  | `farmId`, `ownerId`, `category`, `channel`                                                                                                                                                                                                                                                                  |
| `farm.activated.v1`         | Farm ID issued                         | `farmId`, `farmCode`, `ownerId`, `ownerUserId`, `category`, `productionTypes`, `territoryCode`, `pinCode`, `totalBirdCapacity`                                                                                                                                                                              |
| `farm.review_required.v1`   | Duplicate case opened                  | `farmId`, `caseId`, `signals`, `slaDueAt`                                                                                                                                                                                                                                                                   |
| `farm.needs_attention.v1`   | Changes requested from the owner       | `farmId`, `ownerUserId`, `issues[{docType, code}]`                                                                                                                                                                                                                                                          |
| `farm.status_changed.v1`    | Any status transition                  | `farmId`, `from`, `to`, `actorType`                                                                                                                                                                                                                                                                         |
| `farm.updated.v1`           | Capacity, address or admin correction  | `farmId`, `changedFields`                                                                                                                                                                                                                                                                                   |
| `farm.merged.v1`            | Duplicate merged into an existing farm | `farmId`, `intoFarmId`                                                                                                                                                                                                                                                                                      |
| `farm.owner_kyc_changed.v1` | Owner KYC status moved                 | `ownerId`, `ownerUserId`, `kycStatus`                                                                                                                                                                                                                                                                       |
| `farm.facts_changed.v1`     | After EVERY write to the farm row      | `FarmFactsV1`: `farmId`, `farmCode`, `ownerUserId`, `name`, `category`, `productionTypes`, `gstin`, `gstVerified`, `gstBusinessName`, `gstTradeName`, `invoiceName`, `gstVerifiedAt` (B2B / ITC billing), `stateCode` (GSTIN prefix, else territory state), `territoryCode`, `pinCode`, `status`, `version` |

`farm.facts_changed.v1` is a full snapshot (the farm row `version` after the write), so a read model never has to call farm-service back. Consumer: order-service.

**Content events** (feature `content`, D-50). No coordinates, farm ids or reader ids; readers are
resolved by the consumer through `GET /internal/farms/content/:id/audience?scope=segment|savers|both`
(keyset pages of user ids). Every payload carries `contentId`, `contentVersion`, `kind`, `severity`,
`title`, `placeLabel`.

| Event                  | When                                               | Extra payload                | Consumer audience                     |
| ---------------------- | -------------------------------------------------- | ---------------------------- | ------------------------------------- |
| `content.published.v1` | An item goes live with `notify` (ALERT default)    | `summary`                    | target segment                        |
| `content.corrected.v1` | An approved correction is applied with `notify`    | `correctionNote`             | segment + savers                      |
| `content.retracted.v1` | A live / ended item is withdrawn as wrong (always) | `retractNote`, `wasNotified` | savers (+ segment when `wasNotified`) |

Expected consumers: notification (pass, review and attention messages), loyalty, order, pricing
(tonnage tiers from capacity). The `user.deleted.v1` consumer in farm-service is pending (Phase 2).

### Published by catalog-service

| Type                          | When                                                           | Data                                                     |
| ----------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `catalog.brand_updated.v1`    | Brand name, code, slug or active flag changed                  | `brandId`, `name`, `code`, `slug`, `isActive`, `version` |
| `catalog.brand_deleted.v1`    | Brand soft-deleted (after the product-service reference block) | `brandId`                                                |
| `catalog.category_deleted.v1` | Category soft-deleted (after the reference block)              | `categoryId`                                             |

Consumer: product-service, on queue `product-service.events`. It updates the brand name snapshot and the search text.

### Published by product-service

| Type                                            | When                                                       | Data                                                                                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product.variant_created.v1`                    | Variant created (including with a new product)             | `VariantFactsV1`: ids, SKU, GTIN, names, manufacturer, pack, Rx, temperature class, shelf life, `categoryId`, `categoryPath` (root → self), `brandId`, `hsnCode`, `gstRate`, `minOrderQty`, `maxOrderQty`, `version` |
| `product.variant_updated.v1`                    | Variant or stock-relevant product fact changed             | `VariantFactsV1`                                                                                                                                                                                                     |
| `product.variant_deactivated.v1`                | Variant deactivated or deleted, or product deleted         | `variantId`, `productId`, `version`                                                                                                                                                                                  |
| `product.published.v1` / `product.suspended.v1` | Product became sellable / stopped being sellable           | `productId`, `variantIds`, `reason`                                                                                                                                                                                  |
| `product.review_moderated.v1`                   | A review changed status by moderation (admin or auto-hide) | `reviewId`, `productId`, `userId`, `status`, `action` (approve / reject / hide / restore / auto_hide), `reason` → notification to the author (D-49)                                                                  |
| `product.rating_changed.v1`                     | Published rating totals of a product changed               | `productId`, `ratingAvg` (decimal string or null), `ratingCount`, `sequence` (epoch ms) → search, wishlist cards                                                                                                     |

Consumers: inventory-service (inventory items), logistics master sync (FR-PRD-001), order-service (variant read model). A product category or brand change re-emits `variant_updated` for every variant with the same variant `version`, so consumers order snapshots by (`version`, `occurredAt`).

### Published by inventory-service (built 2026-11-21, D-33 / D-36)

| Type                                 | When                                                                                                                              | Data                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory.availability_changed.v1`  | Network sellable quantity of a variant changed (publisher job, 2 s; deduplicated: only on a real change, incl. a per-node change) | `variantId`, `availableQty`, `inStock`, `lowStock`, `byNode?` (`[{ nodeId, availableQty, inStock }]`, full allocatable set, D-52), `sequence` (per variant) |
| `inventory.low_stock.v1`             | A warehouse × variant **crossed down** to its reorder level (once per dip)                                                        | `variantId`, `warehouseId`, `availableQty`, `threshold`                                                                                                     |
| `inventory.reservation_committed.v1` | `order.paid` accepted (re-sent on a duplicate)                                                                                    | `reservationId`, `orderRef`, `recovered`                                                                                                                    |
| `inventory.reservation_rejected.v1`  | Late payment after expiry and the stock is gone (or nothing is held)                                                              | `reservationId`, `orderRef`, `shortfall[]`                                                                                                                  |
| `inventory.reservation_released.v1`  | Stock given back (reject / cancel / fail / admin / orphan sweep)                                                                  | `reservationId`, `orderRef`, `scope` FULL·PARTIAL, `lines[]`                                                                                                |
| `inventory.reservation_expired.v1`   | An ACTIVE (unpaid) hold passed its window                                                                                         | `reservationId`, `orderRef`                                                                                                                                 |

### Published by payment-service (built 2026-11-22, D-37 / D-45)

Contracts: `packages/infra/src/events/contracts/payment.events.ts`. Money is integer **paise**; only masked instrument data.

| Type                          | When                                                                           | Data                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `payment.captured.v1`         | Money captured (once per payment; also for a closed order → order refunds, R5) | `paymentId`, `orderId`, `orderNo`, `amountPaise`, `expectedPaise`, `currency`, `method`, `providerPaymentId` |
| `payment.failed.v1`           | An attempt failed (retry allowed until expiry)                                 | `paymentId`, `orderId`, `errorCode`, `errorReason`                                                           |
| `payment.expired.v1`          | Not paid before `expiresAt` (after a live gateway check)                       | `paymentId`, `orderId`                                                                                       |
| `payment.refund_initiated.v1` | Gateway accepted the refund                                                    | `refundId`, `sourceRef`, `paymentId`, `orderId`, `amountPaise`, `providerRefundId`, `expectedBy`             |
| `payment.refund_processed.v1` | Refund completed (re-sent if the same `sourceRef` is requested again)          | … + `arn`, `refundedPaise`, `capturedPaise`                                                                  |
| `payment.refund_failed.v1`    | Retries exhausted / refused (EXCEEDS_CAPTURED, PAYMENT_NOT_CAPTURED …)         | `refundId`, `sourceRef`, `paymentId`, `orderId`, `amountPaise`, `reason`                                     |

Built in W2 (2026-11-21, D-54) — wallet top-ups only (purpose WALLET_TOPUP; never sent as the order events above):

| Type                        | When                                                              | Data                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment.topup_captured.v1` | Money for a top-up captured (once per payment, also after expiry) | `paymentId`, `paymentNo`, `topupId`, `userId`, `amountPaise` (captured), `expectedPaise`, `currency`, `method`, masked `bank` / `cardLast4` / `cardNetwork` / `vpaMasked`, `providerPaymentId` |
| `payment.topup_failed.v1`   | A top-up attempt failed (retry allowed)                           | `paymentId`, `topupId`, `userId`, `errorCode`, `errorReason`                                                                                                                                   |
| `payment.topup_expired.v1`  | Not paid in time (after a live check)                             | `paymentId`, `topupId`, `userId`                                                                                                                                                               |

Wallet checkout (W3, D-54): a WALLET payment (order paid in full from the wallet) publishes the same `payment.captured.v1` / `payment.failed.v1` / `payment.expired.v1` with `method: "wallet"` (failure `errorCode` `INSUFFICIENT_WALLET_BALANCE` / `WALLET_FROZEN`); its refunds publish `payment.refund_*` with `arn` = wallet journal number.

### Consumed by payment-service

Queue `payment-service.events`: `order.refund_requested.v1` → refund (unique `sourceRef`; FAILED_FINAL + same sourceRef = retry); `order.rejected.v1` / `order.cancelled.v1` / `order.failed.v1` (scope FULL) → void the open payment.

### Consumed by inventory-service

Queue `inventory-service.events`: `product.variant_created.v1` / `variant_updated.v1` / `variant_deactivated.v1` → `inventory_variant_projections` (version-guarded, incl. temperature class for cold-chain allocation); `order.paid.v1` → commit (or recovery / reject); `order.rejected.v1` / `order.cancelled.v1` / `order.failed.v1` → release (FULL or PARTIAL lines). Order contracts live in `packages/infra/src/events/contracts/order.events.ts` ahead of their producer (OMS P3).

### Consumed by product-service

| Type                                | Producer                                             | Data                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory.availability_changed.v1` | inventory-service                                    | `variantId`, `availableQty`, `inStock`, `lowStock`, `sequence`                                                                                                  |
| `pricing.price_changed.v1`          | pricing-service (future)                             | `variantId`, `sellingPrice`, `currency`, `effectiveFrom`, `sequence`                                                                                            |
| `order.delivered.v1`                | F1 shipments (future; contract in `order.events.ts`) | `orderId`, `orderNo`, `userId`, `deliveredAt`, `lines[{ lineNo, variantId, productId, qty }]`, `netPaidPaise` (D-54: reward points) → review eligibility (D-49) |

A projection applies an event only if its `sequence` is newer than the stored one.

### Published by order-service (orders, built 2026-11-23, D-34…D-45)

Contracts: `packages/infra/src/events/contracts/order.events.ts`. Ids only, never PII.

| Type                        | When                                                                                                                                   | Data                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `order.placed.v1`           | Order created (PENDING_ADMIN_CONFIRMATION, unpaid)                                                                                     | `orderId`, `orderNo`, `userId`, `farmId`, `grandTotal`, `paymentDueAt`                  |
| `order.paid.v1`             | Payment captured for an open order → inventory commits                                                                                 | `orderId`, `orderNo`, `reservationId` (null = look up by order), `paymentId`, `amount`  |
| `order.failed.v1`           | System closed it (unpaid / no stock / late payment, stock gone); also re-sent as ORDER_CLOSED when a commit arrives for a closed order | `orderId`, `orderNo`, `reservationId`, `scope` FULL, `lines`, `reasonCode`              |
| `order.refund_requested.v1` | Refund decision (late payment R5, stock rejected R4, failed after payment)                                                             | `sourceRef`, `orderId`, `paymentId`, `amountPaise`, `reason`, `isSystem`, `requestedBy` |

Built in P4 (2026-11-24):

| Type                      | When                                                                     | Data                                                                                          |
| ------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `order.confirmed.v1`      | Admin confirmed (paid + committed) → future shipments / invoice          | `orderId`, `orderNo`, `reservationId`, `confirmedAt`, active `lines` (lineNo, variantId, qty) |
| `order.rejected.v1`       | Admin rejected, or auto-rejected (REVIEW_TIMEOUT)                        | release shape: `scope` FULL, `reasonCode`                                                     |
| `order.cancelled.v1`      | Buyer / staff cancelled — whole (FULL) or some items (PARTIAL + `lines`) | release shape                                                                                 |
| `order.review_overdue.v1` | A paid order waited longer than the review SLA (once per order)          | `orderId`, `orderNo`, `waitingMinutes`                                                        |

`recovery-watch` re-sends a release (`order.rejected/cancelled/failed`) or `order.refund_requested` that did not land (same keys; consumers are idempotent).

### Consumed by order-service

Queue `order-service.events`: `product.variant_created.v1`, `product.variant_updated.v1`, `product.variant_deactivated.v1`, `pricing.price_changed.v1`, `inventory.availability_changed.v1` (cart soft stock check, `sequence`-guarded), `farm.facts_changed.v1` → `order_variant_projections` and `order_farm_projections`. Facts land only when (`version`, `occurredAt`) is newer than the stored pair; prices only when `sequence` is newer. Variant facts without `categoryId` / `brandId` (an older producer) are ignored.

Queue `order-service.events` now also binds `payment.captured/failed/expired/refund_initiated/refund_processed/refund_failed.v1` and `inventory.reservation_committed/rejected/released.v1` → order lifecycle (row lock + status guards; duplicates and stale events are no-ops). `payment.captured.v1` and `payment.refund_processed.v1` also write the order money ledger first (D-47, idempotent per payment / refund).

### Planned: order management + payments (D-34…D-45, not built yet)

The full list is in [`oms/06-events.md`](oms/06-events.md). It covers:

- `order.placed`, `order.paid`, `order.confirmed`, `order.rejected`, `order.cancelled`, `order.failed`, `order.refund_requested`, `order.review_overdue`
- `payment.captured`, `payment.failed`, `payment.expired`, `payment.refund_initiated`, `payment.refund_processed`, `payment.refund_failed`
- `inventory.reservation_committed`, `inventory.reservation_rejected`, `inventory.reservation_released`

All are `.v1`. Logistics and WMS will consume `order.confirmed.v1` (not `order.paid`, unlike Logistics PRD §8.5). A delivery OTP never travels in an event.

### Published by wallet-service (W1 built 2026-11-20, D-54)

Contracts: `packages/infra/src/events/contracts/wallet.events.ts`. Ids and amounts only.

| Type                           | When                                                                   | Data                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `wallet.transaction_posted.v1` | A journal moved a customer wallet (once per journal, same transaction) | `journalId`, `journalNo`, `userId`, `kind`, `category`, `direction`, `amountPaise`, `balanceAfterPaise`, `refType`, `refId` |
| `points.transaction_posted.v1` | A points journal changed a customer's points (W4)                      | `journalId`, `journalNo`, `userId`, `kind`, `deltaPts`, `availableAfter`, `pendingAfter`, `refType`, `refId`                |
| `points.expiring_soon.v1`      | A lot's points expire within the notice window (once per lot)          | `userId`, `points`, `expiresAt`                                                                                             |

### Consumed by wallet-service

Queue `wallet-service.events`: `order.delivered.v1` → reward points (PENDING, needs `netPaidPaise`), `payment.refund_processed.v1` → pro-rata points reversal (once per refund), `payment.topup_captured.v1` → credit the top-up once (ledger key `topup:<id>`), `payment.topup_failed.v1` → FAILED (retry allowed), `payment.topup_expired.v1` → EXPIRED (a later capture still completes it).

### Consumed by notification-service (built 2026-11-19, D-46)

Queue `notification-service.events` (consume-only; publishes nothing): `order.placed.v1` (also
records order → buyer in `notification_order_projections`), `order.confirmed.v1`,
`order.rejected.v1`, `order.failed.v1` (`ORDER_CLOSED` re-sends notify nobody),
`order.cancelled.v1`, `order.review_overdue.v1`, `payment.captured.v1`, `payment.failed.v1`,
`payment.refund_initiated.v1`, `payment.refund_processed.v1`, `payment.refund_failed.v1`,
`inventory.low_stock.v1`. Business dedupe keys absorb recovery re-sends; buyer events need the
order projection (an event before its `order.placed` is retried, then dead-lettered). Rules,
audiences and channels: [`notifications/README.md`](notifications/README.md#consumed-events).

### Pending design

- **`user.password_reset_requested.v1`.** Plan 02 lists this event, but the OTP code must never
  travel in an event. The open decision is whether auth-service sends OTPs itself through an SMS
  provider, or calls the notification service over internal HTTP. Either way, no event carries the
  code.
- **Role or permission changes.** These stay inside auth-service for now. Other services get
  permissions from the access token, not from events.

## Adding an event

1. Add the type and payload interface to the producer's `contracts/<producer>.events.ts`, and
   extend its `*_EVENTS` and `*EventMap`.
2. Add a row to the catalog above.
3. Write the outbox row in the same transaction as the business change (Phase 2 helper).
4. Consumers: create a queue named `<service>.<purpose>`, bind it to the routing key, and handle
   the event idempotently using the inbox.
