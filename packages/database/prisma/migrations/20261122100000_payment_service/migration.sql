-- payment-service (D-37, D-45): payments, attempts, refunds, webhook events, settings, audit.


-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'FAILED', 'CAPTURED', 'CANCELLED', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('RAZORPAY', 'MOCK');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('CREATED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'RETRYING', 'PROCESSED', 'FAILED_FINAL');

-- CreateTable
CREATE TABLE "payment_audit_log" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "action" VARCHAR(60) NOT NULL,
    "targetType" VARCHAR(30) NOT NULL,
    "targetId" VARCHAR(64) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(500),
    "ip" VARCHAR(45),
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "paymentNo" VARCHAR(24) NOT NULL,
    "orderId" UUID NOT NULL,
    "orderNo" VARCHAR(24) NOT NULL,
    "userId" UUID NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "capturedPaise" BIGINT NOT NULL DEFAULT 0,
    "refundedPaise" BIGINT NOT NULL DEFAULT 0,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "provider" "PaymentProvider" NOT NULL,
    "providerOrderId" VARCHAR(64),
    "providerPaymentId" VARCHAR(64),
    "method" VARCHAR(20),
    "vpaMasked" VARCHAR(80),
    "cardLast4" CHAR(4),
    "cardNetwork" VARCHAR(20),
    "bank" VARCHAR(20),
    "wallet" VARCHAR(20),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "failureCode" VARCHAR(60),
    "failureReason" VARCHAR(300),
    "cancelledAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "amountMismatch" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "providerPaymentId" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "method" VARCHAR(20),
    "errorCode" VARCHAR(60),
    "errorReason" VARCHAR(300),
    "source" VARCHAR(20) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "refundNo" VARCHAR(24) NOT NULL,
    "paymentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "sourceRef" VARCHAR(80) NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "status" "RefundStatus" NOT NULL DEFAULT 'CREATED',
    "requestedBy" UUID,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMP(3),
    "providerRefundId" VARCHAR(64),
    "arn" VARCHAR(64),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lastError" VARCHAR(300),
    "initiatedAt" TIMESTAMP(3),
    "expectedBy" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_settings" (
    "key" VARCHAR(60) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "eventId" VARCHAR(80) NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "payloadSha256" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(500),

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_audit_log_targetType_targetId_createdAt_idx" ON "payment_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_paymentNo_key" ON "payments"("paymentNo");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerOrderId_key" ON "payments"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerPaymentId_key" ON "payments"("providerPaymentId");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_attempts_paymentId_createdAt_idx" ON "payment_attempts"("paymentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_providerPaymentId_status_key" ON "payment_attempts"("providerPaymentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_refundNo_key" ON "refunds"("refundNo");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_sourceRef_key" ON "refunds"("sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_providerRefundId_key" ON "refunds"("providerRefundId");

-- CreateIndex
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

-- CreateIndex
CREATE INDEX "refunds_orderId_idx" ON "refunds"("orderId");

-- CreateIndex
CREATE INDEX "refunds_status_nextRetryAt_idx" ON "refunds"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "payment_webhook_events_processedAt_receivedAt_idx" ON "payment_webhook_events"("processedAt", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_eventId_key" ON "payment_webhook_events"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Hand-written invariants.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amounts_chk" CHECK (
    "amountPaise" > 0 AND "capturedPaise" >= 0 AND "refundedPaise" >= 0
    AND "refundedPaise" <= "capturedPaise"
  );

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_chk" CHECK ("amountPaise" > 0);

-- One live payment per order (a FAILED one is retried on the same gateway order).
CREATE UNIQUE INDEX "payments_live_order_key" ON "payments"("orderId")
  WHERE "status" IN ('CREATED', 'PENDING', 'FAILED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- Jobs: open payments by expiry; refunds due for (re)execution.
CREATE INDEX "payments_open_expiry_idx" ON "payments"("expiresAt")
  WHERE "status" IN ('CREATED', 'PENDING', 'FAILED');
CREATE INDEX "refunds_due_idx" ON "refunds"("nextRetryAt")
  WHERE "status" IN ('APPROVED', 'RETRYING');

-- Attempts and the audit log are append-only.
CREATE TRIGGER "payment_attempts_append_only" BEFORE UPDATE OR DELETE ON "payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "payment_audit_log_append_only" BEFORE UPDATE OR DELETE ON "payment_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "payment_audit_log_no_truncate" BEFORE TRUNCATE ON "payment_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- Default settings (money in paise).
INSERT INTO "payment_settings" ("key", "value") VALUES
  ('refundManualApprovalAbovePaise', '5000000'),
  ('refundMaxAttempts', '6'),
  ('refundExpectedDays', '7'),
  ('reconcileAfterSeconds', '120');
