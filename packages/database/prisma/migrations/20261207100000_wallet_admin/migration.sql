-- CreateEnum
CREATE TYPE "WalletAdjustmentLedger" AS ENUM ('WALLET', 'POINTS');

-- CreateEnum
CREATE TYPE "WalletAdjustmentDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "WalletAdjustmentCategory" AS ENUM ('GOODWILL', 'DAMAGE_CLAIM', 'LOYALTY_BONUS', 'CORRECTION');

-- CreateEnum
CREATE TYPE "WalletAdjustmentStatus" AS ENUM ('PENDING_APPROVAL', 'POSTED', 'REJECTED');

-- CreateTable
CREATE TABLE "wallet_audit_log" (
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

    CONSTRAINT "wallet_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_adjustments" (
    "id" UUID NOT NULL,
    "adjustmentNo" VARCHAR(24) NOT NULL,
    "userId" UUID NOT NULL,
    "ledger" "WalletAdjustmentLedger" NOT NULL,
    "direction" "WalletAdjustmentDirection" NOT NULL,
    "amount" BIGINT NOT NULL,
    "category" "WalletAdjustmentCategory" NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "WalletAdjustmentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requestedBy" UUID NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "decidedBy" UUID,
    "decisionReason" VARCHAR(500),
    "decidedAt" TIMESTAMP(3),
    "journalId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_ledger_checks" (
    "id" UUID NOT NULL,
    "checkType" VARCHAR(40) NOT NULL,
    "refId" VARCHAR(64) NOT NULL,
    "userId" UUID,
    "expected" VARCHAR(80),
    "actual" VARCHAR(80),
    "status" VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "wallet_ledger_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_audit_log_targetType_targetId_createdAt_idx" ON "wallet_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_adjustments_adjustmentNo_key" ON "wallet_adjustments"("adjustmentNo");

-- CreateIndex
CREATE INDEX "wallet_adjustments_status_createdAt_idx" ON "wallet_adjustments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "wallet_adjustments_userId_createdAt_idx" ON "wallet_adjustments"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_adjustments_requestedBy_idempotencyKey_key" ON "wallet_adjustments"("requestedBy", "idempotencyKey");

-- CreateIndex
CREATE INDEX "wallet_ledger_checks_status_detectedAt_idx" ON "wallet_ledger_checks"("status", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_ledger_checks_checkType_refId_key" ON "wallet_ledger_checks"("checkType", "refId");


-- ─── D-54 W5 ───

-- The audit log is append-only.
CREATE TRIGGER "wallet_audit_log_append_only" BEFORE UPDATE OR DELETE ON "wallet_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "wallet_audit_log_no_truncate" BEFORE TRUNCATE ON "wallet_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- Adjustments: positive amounts; the approver is never the requester (segregation of duties);
-- a decided adjustment says who decided, and a posted one points at its journal.
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_amount_chk" CHECK ("amount" > 0);
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_sod_chk"
  CHECK ("decidedBy" IS NULL OR "decidedBy" <> "requestedBy");
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_decision_chk" CHECK (
  ("status" = 'PENDING_APPROVAL' AND "decidedBy" IS NULL AND "journalId" IS NULL)
  OR ("status" = 'POSTED' AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "journalId" IS NOT NULL)
  OR ("status" = 'REJECTED' AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "journalId" IS NULL)
);
-- A decided adjustment is final.
CREATE FUNCTION "wallet_adjustment_final"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'wallet adjustment % is already %', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "wallet_adjustments_final" BEFORE UPDATE ON "wallet_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "wallet_adjustment_final"();
CREATE TRIGGER "wallet_adjustments_no_delete" BEFORE DELETE ON "wallet_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();

-- Adjustments above this need nothing extra yet; the rule lives in settings for the console.
INSERT INTO "wallet_settings" ("key", "value") VALUES
  ('adjustmentMaxPaise', '10000000'),
  ('adjustmentMaxPoints', '1000000');
