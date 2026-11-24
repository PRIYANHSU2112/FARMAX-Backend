# OMS 03 — State machines and recovery

Every transition, in any status column and by any actor (CUSTOMER, STAFF, SYSTEM or SERVICE), runs
the same way:

1. Lock the order row (`SELECT … FOR UPDATE`).
2. Check the expected current state (and `expectedVersion` for staff actions).
3. Write the change and bump `version`.
4. Append one row to **`order_status_events`** (append-only trigger): field, from, to, actor, reasonCode, note, time.
5. Staff actions also write an `order_audit_log` row.
6. Write any side effect to the **outbox**.

All of these happen in one transaction. When two transitions race, exactly one wins; the loser gets
409 with the current state.

## Order `status` (business lifecycle, D-34)

| From                       | To                              | Actor / trigger                                                                           | Guards / effects                                                                                             |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| —                          | PENDING_ADMIN_CONFIRMATION      | Customer checkout                                                                         | Stock reserved, payment intent created                                                                       |
| PENDING_ADMIN_CONFIRMATION | CONFIRMED                       | Staff `orders.confirm`                                                                    | `paymentStatus=PAID`, `stockStatus=COMMITTED`, no `paymentException` → `order.confirmed.v1`                  |
| PENDING_ADMIN_CONFIRMATION | REJECTED                        | Staff `orders.confirm` (reasonCode + reason); system auto-reject (`adminAutoRejectHours`) | Release stock; refund if paid (see Recovery playbook)                                                        |
| PENDING_ADMIN_CONFIRMATION | **FAILED**                      | System                                                                                    | `failureCode`: PAYMENT_NOT_COMPLETED · STOCK_UNAVAILABLE · STOCK_UNAVAILABLE_AFTER_PAYMENT · PLACEMENT_ERROR |
| PENDING_ADMIN_CONFIRMATION | CANCELLED                       | Customer (free) or staff `orders.cancel`                                                  | Release stock; refund if paid                                                                                |
| CONFIRMED                  | CANCELLED                       | Customer within policy (before PICKING); staff with reason                                | Release stock; refund                                                                                        |
| CONFIRMED                  | IN_FULFILMENT                   | _F1_: first shipment ALLOCATED                                                            |                                                                                                              |
| IN_FULFILMENT              | PARTIALLY_DELIVERED / DELIVERED | _F1_: derived from shipments                                                              | DELIVERED only when **all active** shipments are DELIVERED                                                   |
| DELIVERED                  | COMPLETED                       | _F1_: customer confirms receipt, or auto after `autoCompleteHours`                        |                                                                                                              |

Terminal statuses: FAILED (the system could not complete the order), REJECTED (an admin refused it),
CANCELLED (a person cancelled it), COMPLETED. **A terminal order is never revived** (D-44).

## `paymentStatus` (only payment events change it)

```
PENDING ──captured──▶ PAID ──refund processed──▶ PARTIALLY_REFUNDED ──▶ REFUNDED
   │ ▲
   │ └── new attempt (POST /orders/{id}/pay, before paymentDueAt)
   ▼
 FAILED ──paymentDueAt + grace, live check says not captured──▶ EXPIRED  (order → FAILED, D-43)
```

`PARTIALLY_REFUNDED` / `REFUNDED` change only when a refund **completes**, never when one is requested.

## `stockStatus` (only inventory events change it)

```
PENDING ──reserved──▶ RESERVED ──order.paid → committed──▶ COMMITTED
   │                     │                                   │
   ▼ refused            └──────── reject / cancel / fail ───┴─▶ RELEASE_REQUESTED ──released──▶ RELEASED
 FAILED                 late payment, stock gone ──▶ REJECTED
```

## `refundStatus` (summary of the order's refund requests)

`NONE → REQUESTED → IN_PROGRESS → COMPLETED | PARTIALLY_COMPLETED`; `IN_PROGRESS → ACTION_REQUIRED`
when a refund fails for good.

## Refund lifecycles (D-45)

**A. Decision — order-service `OrderRefundRequest`**

| State             | Meaning                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| REQUESTED         | Decision taken (source, amount, `sourceRef`); outbox `order.refund_requested.v1` written |
| ACCEPTED          | `payment.refund_initiated.v1`: refundId, providerRefundId, expectedBy                    |
| COMPLETED         | `payment.refund_processed.v1` (ARN/UTR) → `paymentStatus` and `refundedAmount` updated   |
| FAILED            | `payment.refund_failed.v1` (retries exhausted) → `refundStatus=ACTION_REQUIRED`          |
| RETRY_REQUESTED   | Admin retry: same `sourceRef`, never a second refund                                     |
| MANUALLY_RESOLVED | Refunded offline: reason + bank reference, approver ≠ requester                          |

**B. Execution — payment-service `Refund`**

| State                       | Meaning                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| CREATED                     | Unique `sourceRef`. Under the payment row lock: Σ(live refunds) + amount ≤ captured   |
| PENDING_APPROVAL → APPROVED | Only manual decisions above `refundManualApprovalAbove` (SoD); system refunds skip it |
| PROCESSING                  | Razorpay refund sent; `refund_initiated` emitted                                      |
| PROCESSED                   | Webhook `refund.processed` or the `refund-status` poll                                |
| RETRYING                    | Backoff 1 m · 5 m · 30 m · 2 h · 6 h · 24 h (`refundMaxAttempts` = 6)                 |
| FAILED_FINAL                | Retries exhausted or a non-retryable error → `refund_failed`                          |

## Recovery playbook

### Payment vs reservation races

| #   | Situation                                            | Handling                                                                                                                                                                       | Result                                                   |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| R1  | Reserve refused at checkout                          | Order → FAILED (STOCK_UNAVAILABLE); the intent created in parallel is voided; 409 with **no payment details**                                                                  | Nothing charged                                          |
| R2  | Reserve timed out / outcome unknown                  | `stockStatus` stays PENDING; 503 "retry with the same key". The `stuck-orders` job looks the reservation up by orderRef: ACTIVE → RESERVED, otherwise FAILED (PLACEMENT_ERROR) | Payment details are released only once stock is RESERVED |
| R3  | Captured, hold still live                            | PAID → `order.paid` → COMMITTED                                                                                                                                                | Normal                                                   |
| R4  | Captured after the hold expired, order still pending | Inventory recovery commit (EXPIRED → COMMITTED if sellable); if refused → FAILED (STOCK_UNAVAILABLE_AFTER_PAYMENT) + automatic refund                                          | Charged only with stock, else refunded                   |
| R5  | Captured after the order is terminal                 | PAID recorded; status **not** revived; automatic full refund (LATE_PAYMENT)                                                                                                    | Money returned                                           |
| R6  | Timeout job ∥ capture                                | Same row lock; the job first calls payment `live-status` (gateway refetch) and skips if captured or still pending; if the job wins anyway → R5                                 | One outcome                                              |
| R7  | `order.paid` delayed (broker or inventory down)      | Outbox retries; expired meanwhile → R4                                                                                                                                         | Consistent                                               |
| R8  | Captured amount ≠ grandTotal                         | PAID + `paymentException=AMOUNT_MISMATCH`; stock still committed; confirm blocked; admin rejects → full refund                                                                 | Safe                                                     |
| R9  | Duplicate capture (verify + webhook, redelivery)     | Inbox dedup + status guard                                                                                                                                                     | One effect                                               |

### Reject → release → refund (cancel and fail use the same flow)

1. **One transaction:**
   - lock, then check status and version
   - REJECTED, and reverse redemptions
   - `stockStatus=RELEASE_REQUESTED`
   - if paid: create `OrderRefundRequest` (`sourceRef=reject:{orderId}`) and set `refundStatus=REQUESTED`
   - status event + audit row + outbox (`order.rejected.v1`, `order.refund_requested.v1`)
   - → 200
2. **Release:**
   - Inventory consumes the event, releases the stock (idempotent) and emits `reservation_released.v1`, so `stockStatus` becomes RELEASED.
   - Retries come from the outbox relay and RabbitMQ redelivery.
   - `recovery-watch` re-emits after 15 min.
   - The nightly orphan sweep (`GET /internal/orders/status?ids=`) catches anything lost.
3. **Refund:** lifecycle B. FAILED_FINAL → the admin exceptions queue offers **Retry** or **Resolve offline**.
4. **Reject before payment:** the intent is voided; a capture arriving later → R5.

Source refs: `reject:{orderId}`, `cancel:{cancellationId}`, `fail:{orderId}`, `late:{paymentId}`,
`stock:{orderId}`.

## Shipment (F1 — built in warehouse-service, D-57 amendment 2026-11-24)

**As built (supersedes the design line below):** `PENDING_RELEASE` (placed, not confirmed) →
`RELEASED` (order confirmed) → `ALLOCATED` (FEFO lots) → `ASSIGNED` (task) → `PICKING` → `PACKING`
→ `QC` → `READY_TO_DISPATCH` (staged) → `DISPATCHED` (gate-out; stock issued once per
`dispatchId`) → `OUT_FOR_DELIVERY` (OTP created) → `DELIVERED` (OTP or override + POD) →
`FULFILLED` (final quantities confirmed). Side paths: `DELIVERY_FAILED` → reattempt or
`RETURNED_TO_WAREHOUSE`; `CANCELLED` from any state before DISPATCHED. Hold is a flag (blocks
moving forward), not a state. One **open** shipment per order × warehouse (a backorder follow-up
may ship after the first left). Order status is derived from `shipment.status_changed.v1`
(IN_FULFILMENT once a shipment is ALLOCATED, PARTIALLY_DELIVERED / DELIVERED from active shipments;
order-service merges each snapshot into `orders.shipmentStates` by shipment `version`, so a late or
out-of-order event never moves the status or `fulfilmentStage` back);
cancellation by the customer stops at PICKING, by staff at DISPATCHED. Details: `docs/decisions.md` D-57.

Original design: `ALLOCATED → PICKING → PACKED → DISPATCHED → OUT_FOR_DELIVERY → DELIVERED`; plus
`OUT_FOR_DELIVERY → DELIVERY_FAILED → OUT_FOR_DELIVERY` (reattempt, new OTP) or
`RETURNED_TO_WAREHOUSE`; and `ALLOCATED | PICKING → CANCELLED`.

- One shipment per warehouse.
- DISPATCHED issues the stock (ISSUED).
- DELIVERED requires a verified OTP plus a proof record, then the order status is derived again.

**Delivery OTP (D-40):**

- Created when the shipment enters OUT_FOR_DELIVERY, with `crypto.randomInt` (length from a setting, default 6).
- Stored as HMAC-SHA256 (pepper) for verification, plus an AES-256-GCM copy so the owner can view it in the app.
- TTL 12 h. Locks after 5 failed attempts. Resend: 60 s cooldown, at most 3, and each resend invalidates the previous OTP.
- Verified only by the assigned driver, under the shipment row lock, with a constant-time compare.
- Never written to logs or events.
