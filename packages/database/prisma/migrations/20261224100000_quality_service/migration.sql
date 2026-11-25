-- D-60 quality-service (W16 Sampling & COA) + warehouse-service quality policy / tasks.
-- Local (5433) only until the user applies it to Neon.

-- CreateEnum
CREATE TYPE "QaBatchStateValue" AS ENUM ('PENDING', 'RELEASED', 'QUARANTINED', 'RECALLED');

-- CreateEnum
CREATE TYPE "QaDecisionKind" AS ENUM ('RELEASE', 'QUARANTINE', 'RECALL');

-- CreateEnum
CREATE TYPE "QaDecisionStatus" AS ENUM ('APPLYING', 'APPLIED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "QaTaskStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'NO_STOCK', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "QaLabType" AS ENUM ('IN_HOUSE', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "QaResourceStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "QaReleaseMode" AS ENUM ('MANUFACTURER_COA', 'INDEPENDENT_COA');

-- CreateEnum
CREATE TYPE "QaSpecRule" AS ENUM ('MIN', 'MAX', 'RANGE', 'TEXT');

-- CreateEnum
CREATE TYPE "QaSampleStatus" AS ENUM ('PENDING', 'COLLECTED', 'SENT', 'ACKNOWLEDGED', 'TESTING', 'RESULTS_RECEIVED', 'PASSED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QaSampleSource" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "QaCoaSource" AS ENUM ('MANUFACTURER', 'INDEPENDENT');

-- CreateEnum
CREATE TYPE "QaCoaStatus" AS ENUM ('UPLOADED', 'LINKED', 'RESULTS_ENTERED', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QaVerdict" AS ENUM ('PENDING', 'PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "QaParamVerdict" AS ENUM ('CONFORMS', 'FAILS', 'REVIEW');

-- CreateEnum
CREATE TYPE "WmsQualityTaskStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'NO_STOCK', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "warehouse_batches" ADD COLUMN     "qualityBlocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "qualityVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "quality_batch_states" (
    "batchId" UUID NOT NULL,
    "state" "QaBatchStateValue" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastDecisionId" UUID,
    "updatedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_batch_states_pkey" PRIMARY KEY ("batchId")
);

-- CreateTable
CREATE TABLE "quality_decisions" (
    "id" UUID NOT NULL,
    "decisionNo" VARCHAR(20) NOT NULL,
    "batchId" UUID NOT NULL,
    "kind" "QaDecisionKind" NOT NULL,
    "status" "QaDecisionStatus" NOT NULL DEFAULT 'APPLYING',
    "remarks" VARCHAR(500) NOT NULL,
    "evidenceKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checklist" JSONB NOT NULL,
    "coaIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "expectedVersion" INTEGER NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "decidedBy" UUID NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plannedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "warehousesTotal" INTEGER NOT NULL DEFAULT 0,
    "warehousesDone" INTEGER NOT NULL DEFAULT 0,
    "warehousesFailed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "quality_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_decision_tasks" (
    "decisionId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" "QaTaskStatus" NOT NULL DEFAULT 'PENDING',
    "qtyMoved" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_decision_tasks_pkey" PRIMARY KEY ("decisionId","warehouseId")
);

-- CreateTable
CREATE TABLE "quality_coa_watches" (
    "userId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_coa_watches_pkey" PRIMARY KEY ("userId","batchId")
);

-- CreateTable
CREATE TABLE "quality_notices" (
    "decisionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_notices_pkey" PRIMARY KEY ("decisionId","userId")
);

-- CreateTable
CREATE TABLE "quality_sequences" (
    "kind" VARCHAR(8) NOT NULL,
    "period" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "quality_sequences_pkey" PRIMARY KEY ("kind","period")
);

-- CreateTable
CREATE TABLE "quality_audit_logs" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "actorType" VARCHAR(12) NOT NULL,
    "action" VARCHAR(60) NOT NULL,
    "targetType" VARCHAR(30) NOT NULL,
    "targetId" UUID NOT NULL,
    "warehouseId" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(500),
    "requestId" VARCHAR(64),
    "ip" VARCHAR(45),
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_variants" (
    "variantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "name" VARCHAR(250) NOT NULL,
    "variantName" VARCHAR(250) NOT NULL,
    "brandName" VARCHAR(80),
    "packLabel" VARCHAR(60),
    "imageUrl" VARCHAR(500),
    "temperatureClass" VARCHAR(10) NOT NULL DEFAULT 'AMB',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_variants_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "quality_batches" (
    "batchId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "batchNo" VARCHAR(40) NOT NULL,
    "mfgDate" DATE,
    "expiryDate" DATE,
    "vendorId" UUID,
    "vendorName" VARCHAR(120),
    "serialized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_batches_pkey" PRIMARY KEY ("batchId")
);

-- CreateTable
CREATE TABLE "quality_receipt_lines" (
    "receiptId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "cnNo" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "warehouseName" VARCHAR(120) NOT NULL,
    "batchId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "initialStatus" VARCHAR(20) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_receipt_lines_pkey" PRIMARY KEY ("receiptId","lineNo")
);

-- CreateTable
CREATE TABLE "quality_batch_buyers" (
    "shipmentId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "customerUserId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderNo" VARCHAR(30) NOT NULL,
    "variantId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "dispatchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_batch_buyers_pkey" PRIMARY KEY ("shipmentId","batchId")
);

-- CreateTable
CREATE TABLE "quality_labs" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "accreditation" VARCHAR(120),
    "type" "QaLabType" NOT NULL,
    "tatDays" SMALLINT NOT NULL DEFAULT 5,
    "contactName" VARCHAR(120),
    "contactPhone" VARCHAR(16),
    "contactEmail" VARCHAR(254),
    "address" VARCHAR(300),
    "status" "QaResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_labs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_sku_specs" (
    "variantId" UUID NOT NULL,
    "releaseMode" "QaReleaseMode" NOT NULL DEFAULT 'MANUFACTURER_COA',
    "sampleOnReceipt" BOOLEAN NOT NULL DEFAULT true,
    "sampleQty" INTEGER NOT NULL DEFAULT 3,
    "sampleUnit" VARCHAR(20) NOT NULL DEFAULT 'units',
    "defaultLabId" UUID,
    "coaValidityDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_sku_specs_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "quality_sku_spec_params" (
    "variantId" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "unit" VARCHAR(30),
    "rule" "QaSpecRule" NOT NULL,
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,
    "expectedText" VARCHAR(120),
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "quality_sku_spec_params_pkey" PRIMARY KEY ("variantId","code")
);

-- CreateTable
CREATE TABLE "quality_sku_spec_history" (
    "id" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" UUID NOT NULL,
    "reason" VARCHAR(500),
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_sku_spec_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_samples" (
    "id" UUID NOT NULL,
    "sampleNo" VARCHAR(20) NOT NULL,
    "batchId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "receiptId" UUID,
    "cnNo" VARCHAR(20),
    "qty" INTEGER NOT NULL,
    "qtyUnit" VARCHAR(20) NOT NULL DEFAULT 'units',
    "labId" UUID NOT NULL,
    "source" "QaSampleSource" NOT NULL,
    "status" "QaSampleStatus" NOT NULL DEFAULT 'PENDING',
    "collectedAt" TIMESTAMP(3),
    "collectedBy" UUID,
    "sentAt" TIMESTAMP(3),
    "sentBy" UUID,
    "labRef" VARCHAR(40),
    "acknowledgedAt" TIMESTAMP(3),
    "testingAt" TIMESTAMP(3),
    "resultsAt" TIMESTAMP(3),
    "expectedResultAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_sample_events" (
    "id" UUID NOT NULL,
    "sampleId" UUID NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "fromStatus" "QaSampleStatus",
    "toStatus" "QaSampleStatus",
    "note" VARCHAR(500),
    "actorUserId" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_sample_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_coas" (
    "id" UUID NOT NULL,
    "coaNo" VARCHAR(24) NOT NULL,
    "batchId" UUID,
    "variantId" UUID,
    "source" "QaCoaSource" NOT NULL,
    "labId" UUID,
    "sampleId" UUID,
    "certificateRef" VARCHAR(60),
    "batchNoOnDocument" VARCHAR(40),
    "issuerName" VARCHAR(160),
    "analystName" VARCHAR(120),
    "signatoryName" VARCHAR(120),
    "issuedAt" DATE,
    "validUntil" DATE,
    "mediaKey" VARCHAR(300),
    "fileName" VARCHAR(200),
    "status" "QaCoaStatus" NOT NULL,
    "verdict" "QaVerdict" NOT NULL DEFAULT 'PENDING',
    "specVersion" INTEGER,
    "mappingConfirmedBy" UUID,
    "mappingConfirmedAt" TIMESTAMP(3),
    "enteredBy" UUID,
    "enteredAt" TIMESTAMP(3),
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" VARCHAR(500),
    "publishedAt" TIMESTAMP(3),
    "uploadedBy" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_coas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_coa_results" (
    "coaId" UUID NOT NULL,
    "paramCode" VARCHAR(40) NOT NULL,
    "paramName" VARCHAR(120) NOT NULL,
    "unit" VARCHAR(30),
    "rule" "QaSpecRule" NOT NULL,
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,
    "expectedText" VARCHAR(120),
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "valueNum" DOUBLE PRECISION,
    "valueText" VARCHAR(120),
    "verdict" "QaParamVerdict" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enteredBy" UUID NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_coa_results_pkey" PRIMARY KEY ("coaId","paramCode")
);

-- CreateTable
CREATE TABLE "warehouse_quality_policies" (
    "variantId" UUID NOT NULL,
    "holdOnReceipt" BOOLEAN NOT NULL,
    "releaseMode" VARCHAR(20) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_quality_policies_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "warehouse_quality_tasks" (
    "decisionId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "decisionNo" VARCHAR(20) NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "actorUserId" UUID,
    "reason" VARCHAR(500),
    "status" "WmsQualityTaskStatus" NOT NULL DEFAULT 'PENDING',
    "qtyMoved" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_quality_tasks_pkey" PRIMARY KEY ("decisionId","warehouseId")
);

-- CreateIndex
CREATE UNIQUE INDEX "quality_decisions_decisionNo_key" ON "quality_decisions"("decisionNo");

-- CreateIndex
CREATE UNIQUE INDEX "quality_decisions_idempotencyKey_key" ON "quality_decisions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "quality_decisions_batchId_decidedAt_idx" ON "quality_decisions"("batchId", "decidedAt" DESC);

-- CreateIndex
CREATE INDEX "quality_decisions_status_decidedAt_idx" ON "quality_decisions"("status", "decidedAt");

-- CreateIndex
CREATE INDEX "quality_coa_watches_batchId_idx" ON "quality_coa_watches"("batchId");

-- CreateIndex
CREATE INDEX "quality_audit_logs_targetType_targetId_at_idx" ON "quality_audit_logs"("targetType", "targetId", "at");

-- CreateIndex
CREATE INDEX "quality_audit_logs_actorUserId_at_idx" ON "quality_audit_logs"("actorUserId", "at");

-- CreateIndex
CREATE INDEX "quality_audit_logs_at_idx" ON "quality_audit_logs"("at");

-- CreateIndex
CREATE INDEX "quality_variants_sku_idx" ON "quality_variants"("sku");

-- CreateIndex
CREATE INDEX "quality_batches_batchNo_idx" ON "quality_batches"("batchNo");

-- CreateIndex
CREATE INDEX "quality_batches_variantId_idx" ON "quality_batches"("variantId");

-- CreateIndex
CREATE INDEX "quality_receipt_lines_cnNo_idx" ON "quality_receipt_lines"("cnNo");

-- CreateIndex
CREATE INDEX "quality_receipt_lines_batchId_idx" ON "quality_receipt_lines"("batchId");

-- CreateIndex
CREATE INDEX "quality_batch_buyers_customerUserId_dispatchedAt_idx" ON "quality_batch_buyers"("customerUserId", "dispatchedAt" DESC);

-- CreateIndex
CREATE INDEX "quality_batch_buyers_batchId_idx" ON "quality_batch_buyers"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "quality_labs_code_key" ON "quality_labs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "quality_sku_spec_history_variantId_version_key" ON "quality_sku_spec_history"("variantId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "quality_samples_sampleNo_key" ON "quality_samples"("sampleNo");

-- CreateIndex
CREATE INDEX "quality_samples_warehouseId_status_createdAt_idx" ON "quality_samples"("warehouseId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "quality_samples_status_createdAt_idx" ON "quality_samples"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "quality_samples_batchId_idx" ON "quality_samples"("batchId");

-- CreateIndex
CREATE INDEX "quality_sample_events_sampleId_at_idx" ON "quality_sample_events"("sampleId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "quality_coas_coaNo_key" ON "quality_coas"("coaNo");

-- CreateIndex
CREATE UNIQUE INDEX "quality_coas_sampleId_key" ON "quality_coas"("sampleId");

-- CreateIndex
CREATE INDEX "quality_coas_batchId_source_idx" ON "quality_coas"("batchId", "source");

-- CreateIndex
CREATE INDEX "quality_coas_status_validUntil_idx" ON "quality_coas"("status", "validUntil");

-- CreateIndex
CREATE INDEX "quality_coas_batchNoOnDocument_idx" ON "quality_coas"("batchNoOnDocument");

-- CreateIndex
CREATE INDEX "warehouse_quality_tasks_status_nextAttemptAt_idx" ON "warehouse_quality_tasks"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "warehouse_quality_tasks_batchId_idx" ON "warehouse_quality_tasks"("batchId");

-- AddForeignKey
ALTER TABLE "quality_decision_tasks" ADD CONSTRAINT "quality_decision_tasks_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "quality_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_sku_spec_params" ADD CONSTRAINT "quality_sku_spec_params_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "quality_sku_specs"("variantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_coa_results" ADD CONSTRAINT "quality_coa_results_coaId_fkey" FOREIGN KEY ("coaId") REFERENCES "quality_coas"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Raw SQL objects (not expressible in Prisma) ──

-- One AUTO sample per (receipt, batch): a redelivered receipt event can never create a second one.
CREATE UNIQUE INDEX "quality_samples_auto_once" ON "quality_samples" ("receiptId", "batchId")
  WHERE "source" = 'AUTO';

-- Concurrency safety net: at most one RELEASE decision still applying per batch.
CREATE UNIQUE INDEX "quality_decisions_one_applying_release" ON "quality_decisions" ("batchId")
  WHERE "status" = 'APPLYING' AND "kind" = 'RELEASE';

-- Due tasks for the warehouse executor (PENDING only).
CREATE INDEX "warehouse_quality_tasks_due" ON "warehouse_quality_tasks" ("nextAttemptAt")
  WHERE "status" = 'PENDING';

-- Append-only audit: rows can be inserted, never changed or deleted.
CREATE OR REPLACE FUNCTION quality_audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quality_audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "quality_audit_logs_no_update_delete"
  BEFORE UPDATE OR DELETE ON "quality_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION quality_audit_logs_immutable();
