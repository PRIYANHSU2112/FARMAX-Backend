# OMS 02 — Figma screens → backend, and conflicts

Sources: `Documents/FarmX Marketplace/*.png` (customer app), `Documents/FarmX Marketplace-warehouse/*.png`,
the Consolidated Requirements Document §11.2–11.3 and §19 (FR-PAY, FR-ORD, BL-04/05/07/10/12),
Logistics PRD §8.5, and the admin-panel mock resources (`admin-panel/src/resources/defs/commerce.ts`,
`operations.ts`).

## Screen map

| Screen                                                                                               | Backend                                                                                                              | Phase     |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------- |
| C-07c Cart, Empty cart, C-13b Offers, Coupon View                                                    | `/v1/cart`, `/v1/orders/offers` (built, D-31/D-32)                                                                   | done      |
| address / Farm Location ("served from Mother WH, backup Tanuku C&F")                                 | user-service addresses; serving node = inventory allocation; promise = farm `pin_codes.deliveryPromise`              | P3        |
| Billing Details & Tax Invoice (step 3 of 4)                                                          | `/v1/orders/preview` (built), re-run at checkout                                                                     | done / P3 |
| Payment Method (step 4 of 4, UPI apps)                                                               | `POST /v1/orders/checkout` → payment intent → Razorpay Checkout → `POST /v1/payments/{id}/verify`                    | P2–P3     |
| "Use Farm Wallet ₹1,200" toggle, Wallet, Add money                                                   | wallet (deferred, D-42)                                                                                              | later     |
| C-14a Card Details ("Save card", "Upload image")                                                     | **Razorpay tokenization only; card data never reaches FarmX** (FR-PAY-09)                                            | app       |
| pending (countdown, TXN ref, "Check Status Now")                                                     | `GET /v1/payments/{id}`; reconcile job                                                                               | P2        |
| Retry payment / failed                                                                               | `POST /v1/orders/{id}/pay` (allowed until `paymentDueAt`)                                                            | P3        |
| Order confirmed / Success                                                                            | order PENDING_ADMIN_CONFIRMATION + paid → copy must say "awaiting confirmation" (C-1)                                | P3        |
| C-17a Orders (tabs; "Stock hold 01:14:32 · Pay Now")                                                 | `GET /v1/orders?tab=`; countdown = `paymentDueAt`                                                                    | P3        |
| C-17b Order detail (timeline, "Cancellations locked at picking", Cancel)                             | `GET /v1/orders/{id}` (timeline from `order_status_events`, allowed `actions`)                                       | P3        |
| Cancellation (item-level, reasons, free window, fee)                                                 | `cancellation-quote`, `cancel`                                                                                       | P4        |
| C-17c Live tracking, C-17d Delivery OTP, Details (gate photo)                                        | shipments + OTP + proof                                                                                              | **F1**    |
| C-18a Shipment delivered (Confirm receipt)                                                           | shipment confirm receipt                                                                                             | F1        |
| C-18b Report a problem, C-18c Return RT-…                                                            | returns                                                                                                              | later     |
| C-18d Scheduled & recurring                                                                          | recurring orders                                                                                                     | later     |
| Invoices / Consignment Status ("Download Combined Invoices"), Order confirmed "Download tax invoice" | order-service invoices (D-61): `/v1/orders/{id}/invoices`, `/download`, `/combined`; issued per shipment at gate-out | **built** |
| Warehouse W1.03 Order Fulfilment, Shipments                                                          | WMS events → shipment states                                                                                         | F1        |
| Admin Orders / Payments / Refunds / Returns mocks                                                    | `/v1/admin/orders*`, `/v1/admin/payments`, `/v1/admin/refunds`                                                       | P2–P4     |

## Conflicts and resolutions

| #    | Source                                                  | Conflict                                      | Resolution                                                                                                                    |
| ---- | ------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| C-1  | Figma "Order confirmed"; C-17b step 1 "Order Confirm"   | Shown as confirmed right after payment        | Copy: "Order placed — awaiting confirmation". Timeline: Placed → Payment received → **Confirmed by FarmX**                    |
| C-2  | CRD FR-ORD-01 (Created → Payment Pending → Confirmed …) | Payment drives the state                      | D-34: admin-driven `status` + separate `paymentStatus`. FR-ORD-08's "tele-caller confirmation queue" = the admin review queue |
| C-3  | Admin-panel mock `PLACED → Confirm → CONFIRMED`         | —                                             | Matches. The panel maps PLACED → PENDING_ADMIN_CONFIRMATION                                                                   |
| C-4  | BL-12 "orders confirm only on realised payment"         | —                                             | Confirm requires `paymentStatus = PAID` and `stockStatus = COMMITTED`                                                         |
| C-5  | Inventory plan: 10-minute reservation TTL               | Too short for a manual review                 | D-36: ACTIVE until paid, then COMMITTED with no expiry                                                                        |
| C-6  | C-17a "Stock hold 01:14:32"                             | A countdown longer than an hour               | `paymentWindowMinutes` (default 30) is a setting; the countdown shows `paymentDueAt`                                          |
| C-7  | FR-SHP-07 / Figma: Cold vs Ambient consignments         | Split by temperature                          | D-39: one shipment per **warehouse** (the Figma example uses two warehouses). `splitColdChainInSameWarehouse` reserved        |
| C-8  | C-17d Delivery OTP: 4 boxes, "also via SMS"             | 4-digit OTP; OTPs must never travel in events | D-40: length is a setting (default 6); hashed + encrypted; SMS via an internal call, never an event                           |
| C-9  | Cancellation free window                                | Interaction with admin review                 | Free cancel while PENDING_ADMIN_CONFIRMATION; after CONFIRMED until the first shipment reaches PICKING                        |
| C-10 | Retry / failed screens                                  | —                                             | Pay again while paymentStatus is PENDING or FAILED and before `paymentDueAt`; after that the order is FAILED (D-43)           |
| C-11 | Logistics PRD §8.5 consumes `order.paid`                | Ship before admin approval                    | Logistics/WMS consume **`order.confirmed.v1`**                                                                                |
| C-12 | Card Details screen stores the card                     | PCI (FR-PAY-09)                               | Razorpay Checkout + tokens only                                                                                               |

## Open gaps (documented, not built now)

- Rx items: checkout returns 422 `RX_REQUIRED` until a prescription service exists.
- Delivery promise: interim source is farm `pin_codes.deliveryPromise`.
- Wallet, NEFT/RTGS (FR-PAY-03), payment links / QR for assisted orders, advance / part payment
  (FR-PAY-04), recurring orders, quotations, returns, settlements, e-invoice IRN.
- Farm-supervisor delegates: `farm.facts_changed.v1` must carry delegate user ids before delegates
  can place orders.
