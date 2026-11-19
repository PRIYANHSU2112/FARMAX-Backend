# OMS 01 — High-level design (order management + payments)

Status: **approved plan, not built** (2026-11-20). Decisions D-34 … D-45 in `../decisions.md`.

## Workflow

1. The customer places an order. It is created as **`PENDING_ADMIN_CONFIRMATION`** and its stock is
   reserved for the payment window.
2. The customer pays (prepaid only, BL-12). The reservation is then **committed** and has no expiry.
3. An admin reviews the order and **confirms** it (only if it is paid and committed) or **rejects** it
   (stock released, automatic refund).
4. _(Future, F1)_ Confirmation splits the order into one shipment per warehouse. Each shipment
   runs on its own, ending in an OTP-verified delivery.

The order `status` is separate from `paymentStatus`, `stockStatus` and `refundStatus`
(see [03-state-machines](03-state-machines.md)).

## Service responsibilities

| Service                          | Owns                                                                                                                       | Never does                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **order-service** :3007          | Checkout saga, order records, lifecycle, admin review, cancellation decisions, refund **decisions**, history, manager APIs | Talk to Razorpay; change stock                   |
| **payment-service** :3009 (new)  | Payment intents, gateway (Razorpay / Mock), signature verify, webhooks, refund **execution**, reconciliation               | Decide whether an order is refunded or confirmed |
| **inventory-service** :3008      | Stock, warehouses, PIN allocation, reservations (reserve → commit → issue / release)                                       | Know about payments or admin review              |
| _warehouse / logistics (future)_ | Picking, packing, dispatch, delivery, OTP proof                                                                            |                                                  |
| _notification (future)_          | SMS, WhatsApp, push, email from events                                                                                     |                                                  |
| _invoice (future)_               | GST tax invoices (pdfkit), IRN                                                                                             |                                                  |

## Checkout (fast path)

```
App ──POST /v1/orders/checkout (Idempotency-Key)──▶ order-service
  1. parallel reads: address snapshot (user-service /internal), farm, variants, promotions, settings
  2. tx: lock cart (lockForCheckoutInTx) · re-price (engine) · insert Order PENDING_ADMIN_CONFIRMATION
         stockStatus PENDING · lines · redemptions APPLIED · status event · outbox order.placed
  3. parallel, both idempotent by orderId:
       inventory  POST /internal/inventory/reservations (ttl = paymentWindowMinutes)
       payment    POST /internal/payments (amount = order.grandTotal)
  4. short tx: reservationId, paymentId, stockStatus RESERVED, remove ordered cart lines
◀── 201 {order, payment:{paymentId, provider, keyId, providerOrderId, amount}}
```

- If the reservation is refused, the order becomes **FAILED** and the payment intent is voided. The
  app gets 409 and **no payment details**, so it cannot pay ([R1](03-state-machines.md#recovery-playbook)).
- Target: p95 under 300 ms on local Postgres.

## After checkout (asynchronous: outbox → RabbitMQ, inbox)

```
Razorpay ─▶ payment-service (verify API or webhook, whichever is first) ─▶ payment.captured.v1
order-service ─▶ paymentStatus PAID ─▶ order.paid.v1 ─▶ inventory COMMIT ─▶ reservation_committed.v1
order-service ─▶ stockStatus COMMITTED ─▶ admin review queue
admin confirm ─▶ order.confirmed.v1 ─▶ (future) shipments / invoice / notification
admin reject  ─▶ order.rejected.v1 (inventory release) + order.refund_requested.v1 (payment refund)
```

Nothing in the request path waits for notifications, invoices, refunds or analytics. Side effects are
written as outbox rows in the **same transaction** as the decision, and BullMQ jobs handle timers
and retries ([08-phases](08-phases.md), [06-events](06-events.md)).

## Reservation timing (D-36)

| Step                   | Reservation        | Expiry                         |
| ---------------------- | ------------------ | ------------------------------ |
| Placed                 | ACTIVE             | `paymentWindowMinutes` (30)    |
| Paid                   | COMMITTED          | **none** (safe for any review) |
| Reject / cancel / fail | RELEASED           | —                              |
| Confirmed              | stays COMMITTED    | —                              |
| _(F1)_ Dispatched      | ISSUED (onHand −q) | —                              |

A review that is never completed is auto-rejected after `adminAutoRejectHours` (48), which releases
the stock. A nightly inventory sweep releases reservations whose order is already terminal.

## Recovery

All races between payment and reservation, and the reject → release → refund retries, are described in
[03-state-machines § Recovery](03-state-machines.md#recovery-playbook).
