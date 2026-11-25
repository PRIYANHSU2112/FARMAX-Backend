-- CreateEnum
CREATE TYPE "WmsDeliveredVia" AS ENUM ('STAFF', 'DRIVER_LINK');

-- CreateEnum
CREATE TYPE "WmsExportType" AS ENUM ('POD_ARCHIVE', 'DELIVERED_CSV', 'FULFILLED_CSV');

-- CreateEnum
CREATE TYPE "WmsExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "warehouse_shipments" ADD COLUMN     "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failedReason" VARCHAR(300),
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "settledBy" UUID,
ADD COLUMN     "settlementReason" VARCHAR(24),
ADD COLUMN     "settlementStatus" VARCHAR(12);

-- CreateTable
CREATE TABLE "warehouse_delivery_otps" (
    "shipmentId" UUID NOT NULL,
    "otpHmac" CHAR(64) NOT NULL,
    "otpEnc" VARCHAR(200) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_delivery_otps_pkey" PRIMARY KEY ("shipmentId")
);

-- CreateTable
CREATE TABLE "warehouse_pods" (
    "shipmentId" UUID NOT NULL,
    "receiverName" VARCHAR(120) NOT NULL,
    "receivedLines" JSONB NOT NULL,
    "mediaKeys" TEXT[],
    "signatureMediaKey" VARCHAR(300),
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "byOtp" BOOLEAN NOT NULL,
    "otpVerifiedAt" TIMESTAMP(3),
    "overrideBy" UUID,
    "overrideReason" VARCHAR(500),
    "overrideApprovedBy" UUID,
    "overrideApprovedAt" TIMESTAMP(3),
    "onTime" BOOLEAN,
    "deliveredBy" UUID,
    "deliveredVia" "WmsDeliveredVia" NOT NULL DEFAULT 'STAFF',
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_pods_pkey" PRIMARY KEY ("shipmentId")
);

-- CreateTable
CREATE TABLE "warehouse_dispatch_driver_links" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_dispatch_driver_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_exports" (
    "id" UUID NOT NULL,
    "type" "WmsExportType" NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "status" "WmsExportStatus" NOT NULL DEFAULT 'QUEUED',
    "rows" JSONB,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(500),
    "requestedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "warehouse_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouse_pods_deliveredAt_idx" ON "warehouse_pods"("deliveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_dispatch_driver_links_tokenHash_key" ON "warehouse_dispatch_driver_links"("tokenHash");

-- CreateIndex
CREATE INDEX "warehouse_dispatch_driver_links_tripId_idx" ON "warehouse_dispatch_driver_links"("tripId");

-- CreateIndex
CREATE INDEX "warehouse_exports_requestedBy_createdAt_idx" ON "warehouse_exports"("requestedBy", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_exports_status_createdAt_idx" ON "warehouse_exports"("status", "createdAt");

-- ── Hand-written (D-57b Phase 4b) ──
ALTER TABLE "warehouse_delivery_otps" ADD CONSTRAINT "warehouse_delivery_otps_attempts_check" CHECK ("attempts" >= 0 AND "resendCount" >= 0);
ALTER TABLE "warehouse_shipments" ADD CONSTRAINT "warehouse_shipments_settlement_check"
  CHECK ("settlementStatus" IS NULL OR "settlementStatus" IN ('SETTLED', 'PENDING'));
