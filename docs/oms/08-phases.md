# OMS 08 — Phases, risks, verification

Each phase stops with a report (done, pending, known issues) before the next one starts.

| Phase                                                 | Scope                                                                                                                                                                                                                    | Exit criteria                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **P0 Docs** ✅                                        | This folder; D-33…D-45; API_PLAN, event-contracts and PROGRESS updated                                                                                                                                                   | Reviewed by the owner                                                                  |
| **P1 Inventory** ✅ 2026-11-21                        | inventory-service steps 2–3 with D-36 (ACTIVE → COMMITTED → ISSUED, release), consumers for `order.paid` / `rejected` / `cancelled` / `failed`, events committed / rejected / released, lookup by orderRef, orphan sweep | Reservation concurrency tests green                                                    |
| **P2 Payment service** :3009 ✅ 2026-11-22            | Scaffold, schema, `PaymentProvider` (Razorpay via `fetch`, Mock), internal create / cancel / live-status, verify, webhook + queue, status, reconcile, refunds + retry, events, admin APIs, gateway + Swagger             | Signature vectors, webhook dedup, mock end-to-end, refund retry tests                  |
| **P3 Orders core** ✅ 2026-11-23                      | Schema, sequence, settings, checkout fast path, list / detail / timeline, pay again, consumers (payment, inventory), `payment-timeout` + `stuck-orders`                                                                  | Saga tests: success, fail → retry, unpaid → FAILED, late payment, out of stock (R1–R5) |
| **P4 Admin review + cancel + recovery** ✅ 2026-11-24 | Review queue, stats, confirm / reject / bulk, notes, settings, cancel (customer / admin, partial), refund lifecycle A, exception queues, retry / resolve offline, `review-sla` + `recovery-watch`, new permissions       | Races (confirm ∥ cancel ∥ capture ∥ timeout), R6–R9, refund tests                      |
| F1 (future)                                           | Shipments per warehouse, states, delivery OTP, proof, derived DELIVERED / PARTIALLY_DELIVERED                                                                                                                            |                                                                                        |
| F2+ (future)                                          | Notification service, invoice service (pdfkit GST), returns, wallet, NEFT, recurring orders, settlements                                                                                                                 |                                                                                        |

## Risks

- P3 needs P1. Order checkout cannot ship before the commit, release and issue reservation changes.
- Admin review adds time before dispatch. This is mitigated by SLA alerts and auto-reject.
- Live Razorpay tests need an account (keys and a webhook URL). The mock provider covers development.
- Neon round-trip latency: measure performance only on local Postgres (127.0.0.1:5433).
- Figma copy changes are needed (C-1, C-6).

## Verification

- **Unit:**
  - transition tables (allowed and denied) for every status column
  - refund calculator (pro-rata allocations, leftover paise)
  - Razorpay signature test vectors
  - number formats
  - settings validation
- **Integration** (local Postgres): checkout with stubbed inventory and payment HTTP; every event delivered twice; out-of-order events; timeout job.
- **Concurrency:**
  - two checkouts from one cart → one order
  - confirm ∥ cancel ∥ late capture → one winner, plus a refund when needed
  - verify + duplicate webhook → one capture
  - two admins confirming → 200 + 409
  - bulk confirm with mixed states
  - R1–R9
  - refund duplicates and over-refund attempts
  - inventory down during reject → eventually RELEASED
- **End-to-end** through gateway :3000 with `PAYMENT_PROVIDER=mock`:
  - checkout → mock succeed → PAID → COMMITTED → confirm
  - reject → refund ACCEPTED → PROCESSED → REFUNDED, stock RELEASED
  - unpaid → FAILED + release
  - mock fail → retry → success
- `pnpm typecheck && pnpm lint && pnpm test`. No production-ready claim until the concurrency and end-to-end suites pass.
