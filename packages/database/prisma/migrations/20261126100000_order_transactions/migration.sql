-- CreateEnum
CREATE TYPE "OrderTransactionKind" AS ENUM ('CAPTURE', 'REFUND');

-- CreateEnum
CREATE TYPE "OrderLedgerCheckStatus" AS ENUM ('OK', 'MISMATCH');

-- CreateTable
CREATE TABLE "order_transactions" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" "OrderTransactionKind" NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "method" VARCHAR(20),
    "paymentId" UUID NOT NULL,
    "refundId" UUID,
    "providerRef" VARCHAR(64),
    "sourceRef" VARCHAR(80),
    "idempotencyKey" VARCHAR(100) NOT NULL,
    "sourceEventId" UUID,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_ledger_checks" (
    "paymentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "OrderLedgerCheckStatus" NOT NULL,
    "ledgerCapturedPaise" BIGINT NOT NULL,
    "ledgerRefundedPaise" BIGINT NOT NULL,
    "paymentCapturedPaise" BIGINT NOT NULL,
    "paymentRefundedPaise" BIGINT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_ledger_checks_pkey" PRIMARY KEY ("paymentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_transactions_idempotencyKey_key" ON "order_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "order_transactions_orderId_kind_idx" ON "order_transactions"("orderId", "kind");

-- CreateIndex
CREATE INDEX "order_transactions_paymentId_idx" ON "order_transactions"("paymentId");

-- CreateIndex
CREATE INDEX "order_transactions_recordedAt_idx" ON "order_transactions"("recordedAt");

-- CreateIndex
CREATE INDEX "order_ledger_checks_status_checkedAt_idx" ON "order_ledger_checks"("status", "checkedAt");

-- CreateIndex
CREATE INDEX "order_ledger_checks_orderId_idx" ON "order_ledger_checks"("orderId");

-- Money is always positive; the kind gives the direction.
ALTER TABLE "order_transactions" ADD CONSTRAINT "order_transactions_amount_positive" CHECK ("amountPaise" > 0);
ALTER TABLE "order_transactions" ADD CONSTRAINT "order_transactions_refund_has_id"
  CHECK ("kind" = 'CAPTURE' OR "refundId" IS NOT NULL);

-- The ledger is append-only.
CREATE TRIGGER "order_transactions_append_only" BEFORE UPDATE OR DELETE ON "order_transactions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "order_transactions_no_truncate" BEFORE TRUNCATE ON "order_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- Backfill from what orders already recorded, with the SAME idempotency keys the live events use
-- (a replayed payment event then de-duplicates against these rows).
INSERT INTO "order_transactions"
  ("id", "orderId", "kind", "amountPaise", "currency", "paymentId", "idempotencyKey", "occurredAt")
SELECT gen_random_uuid(), o."id", 'CAPTURE', round(o."paidAmount" * 100)::bigint, o."currency",
       o."activePaymentId", 'capture:' || o."activePaymentId", coalesce(o."paidAt", o."placedAt")
FROM "orders" o
WHERE o."activePaymentId" IS NOT NULL AND o."paidAmount" > 0
ON CONFLICT ("idempotencyKey") DO NOTHING;

INSERT INTO "order_transactions"
  ("id", "orderId", "kind", "amountPaise", "currency", "paymentId", "refundId", "providerRef",
   "sourceRef", "idempotencyKey", "occurredAt")
SELECT gen_random_uuid(), r."orderId", 'REFUND', round(r."amount" * 100)::bigint, 'INR',
       r."paymentId", r."paymentRefundId", coalesce(r."arn", r."providerRefundId"), r."sourceRef",
       'refund:' || r."paymentRefundId", coalesce(r."completedAt", r."updatedAt")
FROM "order_refund_requests" r
WHERE r."status" = 'COMPLETED' AND r."paymentRefundId" IS NOT NULL AND r."amount" > 0
ON CONFLICT ("idempotencyKey") DO NOTHING;
