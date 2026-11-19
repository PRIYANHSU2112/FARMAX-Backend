# OMS 04 — Database design

Shared database `farmx` (D-21). Conventions:

- One Prisma file per feature.
- No relations across features.
- Money is `Decimal(14,2)` in order-service and integer **paise (`BigInt`)** in payment-service.
- Ids are UUID v7.
- Every status change is timestamped and attributed.
- Append-only tables are protected by the `forbid_audit_mutation()` trigger.

## order-service (P3–P4) — `prisma/schema/order/orders.prisma`, `settings.prisma`

### `orders`

| Group     | Columns                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity  | `id`, `orderNo` (unique, `ORD-yy-nnnnnnn`), `userId`, `farmId`, `channel` (APP · WEB · ASSISTED)                                                                                              |
| Status    | `status`, `failureCode?`, `paymentStatus`, `stockStatus`, `refundStatus`, `paymentException?`, `version`                                                                                      |
| Money     | `itemSubtotal`, `discountTotal`, `taxableAmount`, `cgst`, `sgst`, `igst`, `freight`, `freightDiscount`, `grandTotal`, `paidAmount`, `refundedAmount`                                          |
| Snapshots | `priceTrace` Json (BL-02 waterfall), `billing` Json (farm, GSTIN, itcEligible, placeOfSupply), `deliveryAddress` Json (user-service snapshot), `deliveryPromise`, `couponCode`, `cartVersion` |
| Links     | `reservationId`, `activePaymentId`, `idempotencyKey` (unique) + `requestHash`                                                                                                                 |
| Times     | `placedAt`, `paymentDueAt`, `paidAt`, `confirmedAt` / `confirmedBy`, `rejectedAt` / `rejectedBy`, `cancelledAt` / `cancelledBy`, `closeReasonCode`, `closeReason`                             |

Indexes:

- `(userId, placedAt DESC)`: customer list.
- `(status, paymentStatus, stockStatus, placedAt)`: review queue.
- `(farmId)`.
- Partial `(paymentDueAt) WHERE paymentStatus IN ('PENDING','FAILED')`: timeout sweep.

CHECKs: `grandTotal ≥ 0`, `refundedAmount ≤ paidAmount`.

### Other order tables

| Table                   | Key columns                                                                                                                                                                                                                                                                                          | Notes                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `order_lines`           | `orderId`, `lineNo`, `variantId`, `productId`, `sku`, `name`, `hsnCode`, `gstRate`, `temperatureClass`, `qty`, `cancelledQty`, `unitPrice`, `lineGross`, `lineDiscount`, `taxableValue`, `cgst`, `sgst`, `igst`, `lineTotal`, `allocations` Json                                                     | Exact per-promotion paise for refunds                           |
| `order_status_events`   | `orderId`, `shipmentId?`, `field` (STATUS · PAYMENT · STOCK · REFUND · SHIPMENT), `from`, `to`, `actorType`, `actorId?`, `reasonCode?`, `note?`, `at`                                                                                                                                                | **Append-only**; the timeline source                            |
| `order_notes`           | `orderId`, `authorId`, `body`, `createdAt`                                                                                                                                                                                                                                                           | Append-only manager notes                                       |
| `order_cancellations`   | `orderId`, `scope` (FULL · PARTIAL), `lines` Json, `reasonCode`, `note`, `stage`, `fee`, `refundAmount`, `actorType`, `requestedBy`, `idempotencyKey`                                                                                                                                                |                                                                 |
| `order_refund_requests` | `orderId`, `source` (REJECT · CANCEL · FAIL · STOCK_REJECTED · LATE_PAYMENT · AUTO_REJECT · AMOUNT_MISMATCH), `amount`, `sourceRef` (unique), `status`, `paymentRefundId`, `providerRefundId`, `expectedBy`, `completedAt`, `failureReason`, `resolvedBy`, `resolutionRef`, `requestedBy`, `version` | Lifecycle A (03-state-machines)                                 |
| `order_sequences`       | PK (`kind` ORD · RT, `year`), `last`                                                                                                                                                                                                                                                                 | `INSERT … ON CONFLICT DO UPDATE … RETURNING` in the transaction |
| `order_settings`        | `key` PK, `value` Json, `updatedBy`, `updatedAt`                                                                                                                                                                                                                                                     | Seeded; validated per key                                       |

Settings seeded by the migration:

- `paymentWindowMinutes` = 30, `paymentGraceSeconds` = 120
- `adminReviewSlaHours` = 4, `adminAutoRejectHours` = 48 (0 = off)
- `freeCancelMinutes`, `cancellationFeePercent` = 0
- `maxBulkConfirm` = 50
- _F1:_ `autoCompleteHours`, `deliveryOtp*`

**Reused tables:** `promo_redemptions` (APPLIED at placement, REVERSED on cancel / reject / fail), `carts`,
the projections, and `order_audit_log`.

## order-service F1 (future) — `shipments.prisma`

| Table             | Key columns                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shipments`       | `shipmentNo` (`ORD-…-S1`), `orderId`, `warehouseId`, `status`, `version`, `assignedDriverId`, `consignmentRef`, `dispatchedAt`, `outForDeliveryAt`, `deliveredAt`, `failedReason` |
| `shipment_lines`  | `shipmentId`, `orderLineId`, `qty`                                                                                                                                                |
| `shipment_otps`   | `shipmentId`, `otpVersion`, `otpHash`, `otpCipher`, `expiresAt`, `attempts`, `resendCount`, `lastSentAt`, `status` (LIVE · USED · EXPIRED · LOCKED · SUPERSEDED)                  |
| `delivery_proofs` | Append-only: `shipmentId`, `driverUserId`, `otpVerifiedAt`, `photoMediaIds[]`, `lat`, `lng`, `accuracyM`, `capturedAt`, `deviceId`, `receiverName`                                |

## payment-service (P2) — `prisma/schema/payment/*.prisma`

| Table                    | Key columns                                                                                                                                                                                                                                                                                                                                                         | Notes                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `payments`               | `paymentNo` (TXN-…), `orderId`, `orderNo`, `userId`, `amountPaise`, `currency`, `capturedPaise`, `refundedPaise`, `status`, `provider` (RAZORPAY · MOCK), `providerOrderId` (unique), `providerPaymentId` (unique), `method`, `vpaMasked`, `cardLast4`, `cardNetwork`, `bank`, `expiresAt`, `capturedAt`, `failureCode`, `failureReason`, `attemptCount`, `version` | Partial unique: one live payment per order. **Masked data only** |
| `payment_attempts`       | `paymentId`, `providerPaymentId`, `status`, `method`, `errorCode`, `errorReason`, `at`                                                                                                                                                                                                                                                                              | Append-only                                                      |
| `refunds`                | `refundNo`, `paymentId`, `orderId`, `sourceRef` (unique), `amountPaise`, `reason`, `isSystem`, `status`, `providerRefundId`, `arn`, `attempts`, `nextRetryAt`, `lastError`, `approvedBy`, `processedAt`                                                                                                                                                             | Lifecycle B. Σ live ≤ captured (checked under the payment lock)  |
| `payment_webhook_events` | `provider`, `eventId` (unique), `type`, `signatureValid`, `payloadSha256`, `payload`, `receivedAt`, `processedAt`, `attempts`, `error`                                                                                                                                                                                                                              | Dedup + audit of every delivery                                  |
| `payment_settings`       | `key`, `value`                                                                                                                                                                                                                                                                                                                                                      | `refundManualApprovalAbove`, `refundMaxAttempts`, reconcile ages |
| `payment_audit_log`      | Same shape as the other audit logs                                                                                                                                                                                                                                                                                                                                  | Append-only                                                      |

## inventory-service changes (P1, D-36)

- Reservation status: ACTIVE · **COMMITTED** · **ISSUED** · RELEASED · EXPIRED · **REJECTED** (late
  payment, stock gone). Commit no longer deducts on-hand stock; ISSUE (at dispatch, F1) does.
- Reservation lines gain `releasedQty` (partial cancel) and `issuedQty`; held = qty − released − issued.
- Warehouses gain `hasColdChain`; the variant projection gains `temperatureClass` (CC_* lines are
  allocated only to cold-chain warehouses).
- Built in P1: migration `20261121100000_inventory_reservation_commit`.
- Lookup index on `orderRef` (already there) for `GET /internal/inventory/reservations?orderRef=`.
- Plus the consumers and events listed in [06-events](06-events.md).
