-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('ORDER', 'WALLET_TOPUP');

-- CreateEnum
CREATE TYPE "WalletTopupStatus" AS ENUM ('CREATED', 'PENDING', 'FAILED', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WalletTopupMethod" AS ENUM ('UPI', 'NETBANKING', 'CARD');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "purpose" "PaymentPurpose" NOT NULL DEFAULT 'ORDER',
ADD COLUMN     "referenceId" UUID,
ALTER COLUMN "orderId" DROP NOT NULL,
ALTER COLUMN "orderNo" DROP NOT NULL;

-- CreateTable
CREATE TABLE "wallet_settings" (
    "key" VARCHAR(60) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "wallet_topups" (
    "id" UUID NOT NULL,
    "topupNo" VARCHAR(24) NOT NULL,
    "userId" UUID NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "method" "WalletTopupMethod" NOT NULL,
    "status" "WalletTopupStatus" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "paymentId" UUID,
    "paymentNo" VARCHAR(24),
    "creditedPaise" BIGINT,
    "paidMethod" VARCHAR(20),
    "bank" VARCHAR(20),
    "cardLast4" CHAR(4),
    "cardNetwork" VARCHAR(20),
    "vpaMasked" VARCHAR(80),
    "failureCode" VARCHAR(60),
    "failureReason" VARCHAR(300),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "cashbackPaise" BIGINT NOT NULL DEFAULT 0,
    "cashbackPoints" INTEGER NOT NULL DEFAULT 0,
    "journalId" UUID,
    "balanceAfterPaise" BIGINT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_topups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_topups_topupNo_key" ON "wallet_topups"("topupNo");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_topups_paymentId_key" ON "wallet_topups"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_topups_journalId_key" ON "wallet_topups"("journalId");

-- CreateIndex
CREATE INDEX "wallet_topups_userId_createdAt_idx" ON "wallet_topups"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "wallet_topups_status_createdAt_idx" ON "wallet_topups"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_topups_userId_idempotencyKey_key" ON "wallet_topups"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "payments_referenceId_key" ON "payments"("referenceId");


-- ─── D-54 ───

-- A payment is for exactly one thing: an order, or a wallet top-up.
ALTER TABLE "payments" ADD CONSTRAINT "payments_purpose_chk" CHECK (
  ("purpose" = 'ORDER' AND "orderId" IS NOT NULL AND "orderNo" IS NOT NULL AND "referenceId" IS NULL)
  OR ("purpose" = 'WALLET_TOPUP' AND "referenceId" IS NOT NULL AND "orderId" IS NULL AND "orderNo" IS NULL)
);

ALTER TABLE "wallet_topups" ADD CONSTRAINT "wallet_topups_amounts_chk" CHECK (
  "amountPaise" > 0 AND ("creditedPaise" IS NULL OR "creditedPaise" > 0)
  AND "cashbackPaise" >= 0 AND "cashbackPoints" >= 0 AND "failedAttempts" >= 0
);
-- COMPLETED ⇔ credited through the ledger.
ALTER TABLE "wallet_topups" ADD CONSTRAINT "wallet_topups_completed_chk" CHECK (
  ("status" = 'COMPLETED') = ("journalId" IS NOT NULL AND "creditedPaise" IS NOT NULL AND "completedAt" IS NOT NULL)
);
-- A top-up that has a payment is past CREATED.
ALTER TABLE "wallet_topups" ADD CONSTRAINT "wallet_topups_payment_chk" CHECK (
  "status" = 'CREATED' OR "status" = 'EXPIRED' OR "paymentId" IS NOT NULL
);

-- Business rules (validated on read by the settings feature).
INSERT INTO "wallet_settings" ("key", "value") VALUES
  ('topupMinPaise', '10000'),
  ('topupMaxPaise', '5000000'),
  ('topupDailyMaxPaise', '10000000'),
  ('maxBalancePaise', '20000000'),
  ('topupPresetsPaise', '[50000, 70000, 90000, 100000, 200000, 500000]'),
  ('topupWindowMinutes', '30'),
  ('firstTopupCashback', '{"enabled": true, "method": "upi", "percentBps": 1000, "maxPaise": 5000}'),
  ('pointValuePaise', '10');
