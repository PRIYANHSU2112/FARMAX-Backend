# Wallet & Reward Points — wallet-service (:3012, D-54)

A closed-loop customer wallet (money can only be spent on FarmX orders) and reward points, each
kept on its own **double-entry, append-only PostgreSQL ledger**. Redis never holds a balance.
Built in phases W1–W6 (plan: `~/.claude/plans/pasted-content-id-4f6a-deeply-analyze-serene-squirrel.md`).

| Decision                                            | Where                                    |
| --------------------------------------------------- | ---------------------------------------- |
| Wallet OR gateway for an order (never split)        | order-service `paymentMethod`            |
| No transfer, withdrawal or P2P (closed loop)        | no such API exists                       |
| Points earn on delivery only (`order.delivered.v1`) | F1 shipments must publish `netPaidPaise` |
| Only wallet-service writes `wallet_*` / `points_*`  | code boundary + DB roles (below)         |

## 1. App integration (screen → API)

All through the gateway (`/v1`), customer token. Money is **integer paise** everywhere; the
`…Paise` field is the truth, the rupee string is for display.

| Screen                                     | API                                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Points & wallet header                     | `GET /wallet` (balance, `week.credits`, `week.changePercent`) + `GET /rewards` (points, ₹ value, expiring)                                               |
| Points Ledger tab                          | `GET /rewards/ledger?cursor&limit` (`availableAfter` = "Bal:")                                                                                           |
| Wallet Statement tab / Transaction History | `GET /wallet/transactions?category&from&to&cursor&limit`, chips: `GET /wallet/transactions/summary`                                                      |
| Add Money                                  | `GET /wallet/topups/options` → `POST /wallet/topups` (Idempotency-Key) → Razorpay → `POST /payments/{paymentId}/verify` → poll `GET /wallet/topups/{id}` |
| "Wallet Money Added!" modal                | `GET /wallet/topups/{id}` when `status = COMPLETED`: `paymentNo` (Transaction Ref), `balanceAfter`, `cashback.points`                                    |
| Convert →                                  | `POST /rewards/convert {points}` (Idempotency-Key)                                                                                                       |
| Download statement                         | `GET /wallet/statement?ledger=WALLET                                                                                                                     | POINTS&from=YYYY-MM-DD&to=YYYY-MM-DD` → PDF |
| Checkout "pay from wallet"                 | `POST /orders/checkout { …, paymentMethod: "WALLET" }` (409 `INSUFFICIENT_WALLET_BALANCE` / `WALLET_FROZEN`)                                             |

Rules for the app:

- **Every money POST needs an `Idempotency-Key`** (8–64 of `A-Z a-z 0-9 . _ : -`), one per user
  tap. On a timeout or `503 WALLET_BUSY`, retry with the **same** key: it never moves money twice.
  The same key with a different body is `422 IDEMPOTENCY_KEY_REUSED`.
- Never show a balance computed on the phone; always re-read `GET /wallet` after a change.
- Top-up `FAILED` means "that attempt failed, pay again" until `expiresAt`; `EXPIRED` is final
  (a late capture is still credited automatically).

## 2. Data model

| Table                                     | Purpose                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `wallet_accounts`                         | USER (one per customer, balance ≥ 0, ACTIVE / FROZEN) and 4 SYSTEM accounts (no running balance) |
| `wallet_journals` + `wallet_postings`     | one money movement = one journal, ≥ 2 postings summing to 0; append-only                         |
| `wallet_topups`                           | Add Money requests (↔ payment-service `Payment.purpose = WALLET_TOPUP`)                          |
| `points_accounts`                         | AVAILABLE / PENDING / DEBT buckets per customer + 4 SYSTEM accounts                              |
| `points_journals` + `points_postings`     | points movements, double-entry, append-only                                                      |
| `points_lots` + `points_lot_consumptions` | which points expire when; FIFO by expiry for spending, expiry, reversal                          |
| `wallet_adjustments`                      | staff credits / debits (two-person approval)                                                     |
| `wallet_settings`                         | all business rules (validated on read, changed only through the audited API)                     |
| `wallet_audit_log`                        | append-only staff actions                                                                        |
| `wallet_ledger_checks`                    | reconciliation findings (OPEN / RESOLVED)                                                        |

Journal kinds → statement chip: TOPUP → TOPUPS · ORDER_DEBIT → PURCHASES · REFUND_CREDIT → REFUNDS ·
POINTS_CONVERSION → REWARDS · adjustments by category (DAMAGE_CLAIM → REFUNDS, LOYALTY_BONUS →
REWARDS, others → ADJUSTMENTS).

## 3. How money stays right

**In the database (cannot be bypassed by code):**

- CHECKs: user balance ≥ 0, system balance = 0, amounts ≠ 0, points buckets ≥ 0, lots consistent.
- Triggers: journals / postings / audit append-only; a frozen account can't lose money; every user
  posting continues the balance chain (`balanceAfter = previous + amount = account balance`);
  at COMMIT every journal sums to 0 and every balance / bucket equals the SUM of its postings.
- Unique keys: one journal per idempotency key (`topup:<id>`, `pay:<paymentId>`,
  `refund:<refundId>`, `convert:<user>:<key>`, `adj:<id>`, `earn:<orderId>`, `reverse:<refundId>`).
- Adjustments: approver ≠ requester (CHECK), decided rows are final (trigger).

**In the service:**

- A balance changes only through one conditional `UPDATE … WHERE balance + Δ ≥ 0 AND status = ACTIVE`
  under the row lock (credits always land, even when frozen).
- The journal key is claimed first (`INSERT … ON CONFLICT DO NOTHING`); a concurrent duplicate
  waits and then replays the winner.
- Lock order is always **points account → wallet account** (conversion, top-up cashback).
- `lock_timeout = 3 s`; a lock or pool wait becomes `503 WALLET_BUSY` (safe to retry).
- Inside a transaction every read uses that transaction (a pool read there deadlocked the pool
  under load — found and fixed in W6).
- Side effects (events) go through the transactional outbox; consumed events are de-duplicated by
  the inbox AND by the business keys.

## 4. Events

Published: `wallet.transaction_posted.v1`, `points.transaction_posted.v1`, `points.expiring_soon.v1`.
Consumed (queue `wallet-service.events`): `payment.topup_captured|failed|expired.v1`,
`payment.refund_processed.v1` (points reversal), `order.delivered.v1` (points earn).
payment-service publishes top-up outcomes only as `payment.topup_*`; wallet-paid orders use the
normal `payment.captured.v1` (`method: "wallet"`). Details: `docs/event-contracts.md`.

## 5. Jobs (BullMQ queue `wallet-jobs`)

| Job               | Every  | Does                                                                     |
| ----------------- | ------ | ------------------------------------------------------------------------ |
| `topup-reconcile` | 60 s   | open top-ups > 2 min, least recently checked first → payment live status |
| `cashback-sweep`  | 10 min | completed top-ups whose cashback points are not granted                  |
| `points-mature`   | 15 min | PENDING lots past their hold → AVAILABLE                                 |
| `points-expire`   | 60 min | AVAILABLE lots past expiry → EXPIRE                                      |
| `points-notice`   | 24 h   | lots expiring within the notice window → `points.expiring_soon.v1`       |
| `ledger-check`    | 15 min | re-derives every balance from postings / lots / top-ups → findings       |

## 6. Staff console (`/v1/admin/wallet`, permissions `wallet.view|adjust|approve|configure`)

Wallets and detail, journals, freeze / unfreeze (reason, audited), adjustments (request →
**another person** approves or rejects), rules (`PUT /settings/{key}` with reason, audited),
ledger checks (`GET`, `POST /run`). New permissions need `pnpm db:seed` on each database.

## 7. Deploy checklist

1. `pnpm db:deploy` with the **owner** URL (migrations `20261203…`–`20261207…`).
2. `pnpm db:seed` (permissions `wallet.*`).
3. `psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -v wallet_password=… -v app_password=… -f infra/sql/wallet-roles.sql`
   — re-run after every migration. Then give wallet-service `DATABASE_URL` = `farmx_wallet`, every
   other service `farmx_app`; the migrate job keeps the owner URL.
4. `WALLET_SERVICE_URL` for payment-service and order-service, `PAYMENT_SERVICE_URL` +
   `INTERNAL_SERVICE_TOKEN` for wallet-service, `EVENTS_ENABLED` / `JOBS_ENABLED` on.
5. Smoke: `GET /v1/wallet-service/health/ready`, then `POST /v1/admin/wallet/ledger-checks/run` → `open: 0`.

## 8. Runbook

| Symptom                                 | Check / action                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger check OPEN finding               | Never edit a ledger row. Find the cause (`wallet_audit_log`, journals by `refId`), correct with an approved adjustment or a REVERSAL; the next run resolves it. |
| Customer paid, top-up still PENDING     | `GET /v1/wallet/topups/{id}` (live check) or wait for `topup-reconcile`; payment-service `POST /v1/admin/payments/{id}/reconcile`.                              |
| Many `503 WALLET_BUSY`                  | One wallet is hot (expected for bursts on one account) or the DB pool is exhausted: check pool size and slow queries. Clients retry with the same key.          |
| Wallet checkout payment PENDING         | wallet-service unreachable at checkout; payment-service reconcile settles it (never debits after the window).                                                   |
| Points not earned for a delivered order | `order.delivered.v1` must carry `netPaidPaise`; look for the lot `(ORDER, orderId)`.                                                                            |
| Customer disputes a charge              | Freeze the wallet (debits stop, credits land), investigate, adjust with approval, unfreeze.                                                                     |

## 9. Verified (2026-11-21)

Load test `services/wallet-service/scripts/load.ts` (local, dev mode, 10 customers): 50 parallel
top-ups (cashback granted exactly once per customer), 400 reads (p95 ≈ 0.4 s), 300 parallel debits
on one wallet that could pay 100 → exactly 100 paid, the rest `INSUFFICIENT_BALANCE` or
`503 WALLET_BUSY`, balance exact; debits racing conversions; ledger check 0 findings. The full
wallet-service test suite also passes when connected as the least-privileged `farmx_wallet` role.
