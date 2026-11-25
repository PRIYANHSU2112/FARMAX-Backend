-- D-62 W5 Gate & Weighbridge (warehouse-service feature: gate). Local dev DB only until applied to Neon.

-- CreateEnum
CREATE TYPE "WmsGatePurpose" AS ENUM ('INBOUND_CONSIGNMENT', 'STOCK_TRANSFER', 'CUSTOMER_RETURN', 'OTHER');

-- CreateEnum
CREATE TYPE "WmsGateVehicleType" AS ENUM ('MINI_TRUCK', 'LCV', 'TRUCK', 'HEAVY_TRUCK', 'MULTI_AXLE', 'REEFER', 'TRACTOR_TRAILER', 'OTHER');

-- CreateEnum
CREATE TYPE "WmsInboundStage" AS ENUM ('EXPECTED', 'ARRIVED', 'WEIGHED_IN', 'APPROVED', 'UNLOADING', 'UNLOADED', 'WEIGHED_OUT', 'PASS_OUT', 'BLOCKED', 'HELD', 'REJECTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WmsGateEntryStatus" AS ENUM ('ARRIVED', 'WEIGHED_IN', 'APPROVED', 'UNLOADING', 'UNLOADED', 'WEIGHED_OUT', 'PASS_OUT', 'BLOCKED', 'HELD', 'REJECTED', 'EXITED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WmsGateOutcome" AS ENUM ('COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WmsGateShipmentAction" AS ENUM ('REEXPECT', 'CANCEL');

-- CreateEnum
CREATE TYPE "WmsGateReconResult" AS ENUM ('WITHIN', 'BREACH', 'NO_DECLARED_WEIGHT');

-- CreateEnum
CREATE TYPE "WmsGateExitCheckResult" AS ENUM ('WITHIN', 'MISMATCH');

-- CreateEnum
CREATE TYPE "WmsGateBlockReason" AS ENUM ('MISSING_DOCUMENT', 'INVALID_DOCUMENT', 'EWAY_BILL_EXPIRED', 'VEHICLE_MISMATCH', 'DRIVER_UNVERIFIED', 'SECURITY_CONCERN', 'OTHER');

-- CreateEnum
CREATE TYPE "WmsGateHoldReason" AS ENUM ('BREACH', 'NO_DECLARED_WEIGHT', 'MANUAL');

-- CreateEnum
CREATE TYPE "WmsGateHoldResolution" AS ENUM ('ACCEPT_VARIANCE', 'REWEIGH', 'ACCEPT_WITH_DEBIT_NOTE');

-- CreateEnum
CREATE TYPE "WmsWeighKind" AS ENUM ('GROSS', 'TARE', 'EXIT_CHECK');

-- CreateEnum
CREATE TYPE "WmsWeighMethod" AS ENUM ('MANUAL', 'OVERRIDE', 'REWEIGH');

-- CreateEnum
CREATE TYPE "WmsWeighStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'PENDING_APPROVAL', 'REJECTED');

-- CreateEnum
CREATE TYPE "WmsScaleCapture" AS ENUM ('MANUAL', 'DEVICE');

-- CreateEnum
CREATE TYPE "WmsGateDocType" AS ENUM ('PURCHASE_ORDER', 'DELIVERY_CHALLAN', 'INVOICE', 'EWAY_BILL', 'RC_BOOK', 'PERMIT', 'INSURANCE', 'DRIVER_LICENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "WmsGateDocStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'EXEMPTED');

-- CreateEnum
CREATE TYPE "WmsGatePassType" AS ENUM ('INWARD', 'OUTWARD');

-- CreateEnum
CREATE TYPE "WmsGatePassStatus" AS ENUM ('ISSUED', 'USED', 'VOID');

-- CreateEnum
CREATE TYPE "WmsAsnStatus" AS ENUM ('RECEIVED', 'PENDING', 'MATCHED', 'UNMATCHED', 'PARTIALLY_CONVERTED', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WmsAsnSource" AS ENUM ('STAFF', 'VENDOR_API');

-- CreateEnum
CREATE TYPE "WmsVisitorStatus" AS ENUM ('PENDING', 'ON_SITE', 'CHECKED_OUT', 'DENIED');

-- CreateEnum
CREATE TYPE "WmsOutwardStatus" AS ENUM ('PENDING_AUTH', 'AUTHORIZED', 'EXITED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WmsSecuritySubject" AS ENUM ('ENTRY', 'VISITOR', 'OUTWARD');

-- CreateEnum
CREATE TYPE "WmsSecurityResult" AS ENUM ('CLEAR', 'HOLD');

-- CreateEnum
CREATE TYPE "WmsCheckOutcome" AS ENUM ('PASS', 'FAIL', 'NA');

-- CreateEnum
CREATE TYPE "WmsSecuritySource" AS ENUM ('MANUAL', 'AUTO');

-- AlterTable
ALTER TABLE "warehouse_dock_bookings" ADD COLUMN     "asnId" UUID,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "inboundShipmentId" UUID,
ADD COLUMN     "vendorId" UUID;

-- CreateTable
CREATE TABLE "warehouse_inbound_shipments" (
    "id" UUID NOT NULL,
    "shipmentNo" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "purpose" "WmsGatePurpose" NOT NULL DEFAULT 'INBOUND_CONSIGNMENT',
    "vendorId" UUID,
    "vendorCode" VARCHAR(20),
    "vendorName" VARCHAR(120),
    "restockRequestId" UUID,
    "restockRequestNo" VARCHAR(20),
    "vendorPoNo" VARCHAR(40),
    "transferId" UUID,
    "asnId" UUID,
    "sourceLocation" VARCHAR(160),
    "transportType" "WmsGateVehicleType" NOT NULL,
    "plannedVehicleRegNo" VARCHAR(16),
    "plannedDriverName" VARCHAR(120),
    "plannedDriverMobile" VARCHAR(16),
    "vehicleRegNo" VARCHAR(16),
    "etaAt" TIMESTAMP(3) NOT NULL,
    "dockDoorId" UUID,
    "bayCode" VARCHAR(20),
    "dockBookingId" UUID,
    "totalUnits" INTEGER NOT NULL DEFAULT 0,
    "declaredNetKg" DECIMAL(12,2),
    "invoiceNetKg" DECIMAL(12,2),
    "invoiceGrossKg" DECIMAL(12,2),
    "palletCount" INTEGER,
    "payloadLabel" VARCHAR(80) NOT NULL DEFAULT '',
    "stage" "WmsInboundStage" NOT NULL DEFAULT 'EXPECTED',
    "activeEntryId" UUID,
    "rebookingRequired" BOOLEAN NOT NULL DEFAULT false,
    "attemptNo" SMALLINT NOT NULL DEFAULT 1,
    "notes" VARCHAR(500),
    "searchText" VARCHAR(400) NOT NULL DEFAULT '',
    "idempotencyKey" VARCHAR(64),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" VARCHAR(500),
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_inbound_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_inbound_lines" (
    "shipmentId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" UUID NOT NULL,
    "sku" VARCHAR(60),
    "name" VARCHAR(200),
    "packLabel" VARCHAR(60),
    "expectedQty" INTEGER NOT NULL,
    "unitWeightGrams" INTEGER,
    "declaredNetKg" DECIMAL(12,2),

    CONSTRAINT "warehouse_inbound_lines_pkey" PRIMARY KEY ("shipmentId","lineNo")
);

-- CreateTable
CREATE TABLE "warehouse_gate_entries" (
    "id" UUID NOT NULL,
    "entryNo" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "vehicleRegNo" VARCHAR(16) NOT NULL,
    "vehicleType" "WmsGateVehicleType" NOT NULL,
    "driverName" VARCHAR(120) NOT NULL,
    "driverMobile" VARCHAR(16) NOT NULL,
    "driverLicenceNo" VARCHAR(30),
    "driverVerified" BOOLEAN NOT NULL DEFAULT false,
    "plateMatched" BOOLEAN NOT NULL,
    "plateNote" VARCHAR(300),
    "arrivedAt" TIMESTAMP(3) NOT NULL,
    "dockDoorId" UUID,
    "bayCode" VARCHAR(20),
    "status" "WmsGateEntryStatus" NOT NULL DEFAULT 'ARRIVED',
    "pausedFromStatus" "WmsGateEntryStatus",
    "outcome" "WmsGateOutcome",
    "grossKg" DECIMAL(12,2),
    "tareKg" DECIMAL(12,2),
    "netKg" DECIMAL(12,2),
    "expectedLoadKg" DECIMAL(12,2),
    "packagingAllowanceKg" DECIMAL(12,2),
    "varianceKg" DECIMAL(12,2),
    "toleranceKg" DECIMAL(12,2),
    "reconBasis" VARCHAR(20),
    "reconResult" "WmsGateReconResult",
    "exitCheckKg" DECIMAL(12,2),
    "exitCheckResult" "WmsGateExitCheckResult",
    "blockReason" "WmsGateBlockReason",
    "blockHoldLocation" VARCHAR(120),
    "blockRemarks" VARCHAR(500),
    "blockedAt" TIMESTAMP(3),
    "blockedBy" UUID,
    "holdReason" "WmsGateHoldReason",
    "holdNote" VARCHAR(500),
    "heldAt" TIMESTAMP(3),
    "heldBy" UUID,
    "holdResolution" "WmsGateHoldResolution",
    "holdResolvedAt" TIMESTAMP(3),
    "holdResolvedBy" UUID,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" UUID,
    "approvalRemarks" VARCHAR(500),
    "rejectionReason" VARCHAR(500),
    "pendingShipmentAction" "WmsGateShipmentAction",
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" UUID,
    "shipmentActionAppliedAt" TIMESTAMP(3),
    "debitNoteRequired" BOOLEAN NOT NULL DEFAULT false,
    "noReceipt" BOOLEAN NOT NULL DEFAULT false,
    "noReceiptReason" VARCHAR(500),
    "rcvNo" VARCHAR(20),
    "handoverAt" TIMESTAMP(3),
    "handoverBy" UUID,
    "unloadedAt" TIMESTAMP(3),
    "unloadedBy" UUID,
    "dockInAt" TIMESTAMP(3),
    "dockOutAt" TIMESTAMP(3),
    "grossAt" TIMESTAMP(3),
    "tareAt" TIMESTAMP(3),
    "passOutAt" TIMESTAMP(3),
    "exitedAt" TIMESTAMP(3),
    "exitedBy" UUID,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" VARCHAR(500),
    "piiRedactedAt" TIMESTAMP(3),
    "idempotencyKey" VARCHAR(64),
    "createdBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_gate_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_gate_entry_receipts" (
    "gateEntryId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "cnNo" VARCHAR(20) NOT NULL,
    "finalForGate" BOOLEAN NOT NULL DEFAULT false,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attachedBy" UUID,

    CONSTRAINT "warehouse_gate_entry_receipts_pkey" PRIMARY KEY ("gateEntryId","receiptId")
);

-- CreateTable
CREATE TABLE "warehouse_weigh_scales" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "maxCapacityKg" DECIMAL(12,2) NOT NULL,
    "divisionKg" DECIMAL(8,2) NOT NULL DEFAULT 10,
    "captureMethod" "WmsScaleCapture" NOT NULL DEFAULT 'MANUAL',
    "calibratedAt" DATE,
    "calibrationValidUntil" DATE,
    "certificateMediaKey" VARCHAR(300),
    "status" "WmsResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastWeighedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_weigh_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_weighments" (
    "id" UUID NOT NULL,
    "gateEntryId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "kind" "WmsWeighKind" NOT NULL,
    "scaleId" UUID,
    "weightKg" DECIMAL(12,2) NOT NULL,
    "method" "WmsWeighMethod" NOT NULL DEFAULT 'MANUAL',
    "slipNo" VARCHAR(40),
    "slipMediaKey" VARCHAR(300),
    "status" "WmsWeighStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" VARCHAR(500),
    "capturedBy" UUID NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" VARCHAR(500),
    "supersedesId" UUID,

    CONSTRAINT "warehouse_weighments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_gate_documents" (
    "id" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "gateEntryId" UUID,
    "docType" "WmsGateDocType" NOT NULL,
    "refNo" VARCHAR(60),
    "validUntil" DATE,
    "mediaKey" VARCHAR(300),
    "fileName" VARCHAR(160),
    "sizeBytes" INTEGER,
    "contentType" VARCHAR(60),
    "status" "WmsGateDocStatus" NOT NULL DEFAULT 'PENDING',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "expired" BOOLEAN NOT NULL DEFAULT false,
    "carriedForward" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(500),
    "uploadedBy" UUID,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedBy" UUID,
    "verifiedAt" TIMESTAMP(3),
    "mediaPurgedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_gate_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_gate_passes" (
    "id" UUID NOT NULL,
    "passNo" VARCHAR(20) NOT NULL,
    "type" "WmsGatePassType" NOT NULL,
    "gateEntryId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "outcome" "WmsGateOutcome",
    "kid" VARCHAR(20) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "status" "WmsGatePassStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedBy" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "usedBy" UUID,
    "voidedAt" TIMESTAMP(3),
    "voidReason" VARCHAR(300),
    "replacedById" UUID,
    "reissueOfId" UUID,

    CONSTRAINT "warehouse_gate_passes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_gate_events" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "gateEntryId" UUID,
    "type" VARCHAR(40) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byUserId" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "warehouse_gate_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_asns" (
    "id" UUID NOT NULL,
    "vendorAsnRef" VARCHAR(40) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "vendorName" VARCHAR(120),
    "restockRequestId" UUID,
    "restockRequestNo" VARCHAR(20),
    "vehicleRegNo" VARCHAR(16),
    "etaAt" TIMESTAMP(3) NOT NULL,
    "expectedUnits" INTEGER NOT NULL DEFAULT 0,
    "declaredNetKg" DECIMAL(12,2),
    "dockBookingId" UUID,
    "status" "WmsAsnStatus" NOT NULL DEFAULT 'RECEIVED',
    "matchIssues" JSONB NOT NULL DEFAULT '[]',
    "source" "WmsAsnSource" NOT NULL DEFAULT 'STAFF',
    "notes" VARCHAR(500),
    "createdBy" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_asns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_asn_lines" (
    "asnId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" UUID NOT NULL,
    "sku" VARCHAR(60),
    "name" VARCHAR(200),
    "packLabel" VARCHAR(60),
    "qty" INTEGER NOT NULL,
    "declaredNetKg" DECIMAL(12,2),
    "convertedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_asn_lines_pkey" PRIMARY KEY ("asnId","lineNo")
);

-- CreateTable
CREATE TABLE "warehouse_gate_visitors" (
    "id" UUID NOT NULL,
    "visitorNo" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "mobile" VARCHAR(16),
    "company" VARCHAR(120),
    "purpose" VARCHAR(80) NOT NULL,
    "hostLabel" VARCHAR(120),
    "hostUserId" UUID,
    "status" "WmsVisitorStatus" NOT NULL DEFAULT 'PENDING',
    "entryAt" TIMESTAMP(3),
    "exitAt" TIMESTAMP(3),
    "gateEntryId" UUID,
    "createdBy" UUID NOT NULL,
    "anonymizedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_gate_visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_gate_outward_materials" (
    "id" UUID NOT NULL,
    "omNo" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "material" VARCHAR(160) NOT NULL,
    "qty" DECIMAL(12,2) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "vehicleRegNo" VARCHAR(16),
    "receiver" VARCHAR(120),
    "remarks" VARCHAR(500),
    "status" "WmsOutwardStatus" NOT NULL DEFAULT 'PENDING_AUTH',
    "createdBy" UUID NOT NULL,
    "authorizedBy" UUID,
    "authorizedAt" TIMESTAMP(3),
    "exitedBy" UUID,
    "exitedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_gate_outward_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_gate_security_checks" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "subjectType" "WmsSecuritySubject" NOT NULL,
    "subjectId" UUID NOT NULL,
    "subjectRef" VARCHAR(40) NOT NULL,
    "identityCheck" "WmsCheckOutcome" NOT NULL DEFAULT 'NA',
    "plateCheck" "WmsCheckOutcome" NOT NULL DEFAULT 'NA',
    "outwardCheck" "WmsCheckOutcome" NOT NULL DEFAULT 'NA',
    "source" "WmsSecuritySource" NOT NULL DEFAULT 'MANUAL',
    "reason" VARCHAR(60),
    "remarks" VARCHAR(500),
    "result" "WmsSecurityResult" NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" VARCHAR(500),

    CONSTRAINT "warehouse_gate_security_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_inbound_shipments_shipmentNo_key" ON "warehouse_inbound_shipments"("shipmentNo");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_inbound_shipments_idempotencyKey_key" ON "warehouse_inbound_shipments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "warehouse_inbound_shipments_warehouseId_stage_etaAt_idx" ON "warehouse_inbound_shipments"("warehouseId", "stage", "etaAt");

-- CreateIndex
CREATE INDEX "warehouse_inbound_shipments_warehouseId_etaAt_idx" ON "warehouse_inbound_shipments"("warehouseId", "etaAt");

-- CreateIndex
CREATE INDEX "warehouse_inbound_shipments_restockRequestId_idx" ON "warehouse_inbound_shipments"("restockRequestId");

-- CreateIndex
CREATE INDEX "warehouse_inbound_shipments_asnId_idx" ON "warehouse_inbound_shipments"("asnId");

-- CreateIndex
CREATE INDEX "warehouse_inbound_lines_variantId_idx" ON "warehouse_inbound_lines"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_gate_entries_entryNo_key" ON "warehouse_gate_entries"("entryNo");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_gate_entries_idempotencyKey_key" ON "warehouse_gate_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "warehouse_gate_entries_shipmentId_idx" ON "warehouse_gate_entries"("shipmentId");

-- CreateIndex
CREATE INDEX "warehouse_gate_entries_warehouseId_vehicleRegNo_idx" ON "warehouse_gate_entries"("warehouseId", "vehicleRegNo");

-- CreateIndex
CREATE INDEX "warehouse_gate_entries_warehouseId_arrivedAt_idx" ON "warehouse_gate_entries"("warehouseId", "arrivedAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_gate_entries_warehouseId_status_idx" ON "warehouse_gate_entries"("warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_gate_entry_receipts_receiptId_key" ON "warehouse_gate_entry_receipts"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_weigh_scales_warehouseId_code_key" ON "warehouse_weigh_scales"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "warehouse_weighments_gateEntryId_kind_idx" ON "warehouse_weighments"("gateEntryId", "kind");

-- CreateIndex
CREATE INDEX "warehouse_weighments_warehouseId_status_idx" ON "warehouse_weighments"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "warehouse_gate_documents_shipmentId_docType_idx" ON "warehouse_gate_documents"("shipmentId", "docType");

-- CreateIndex
CREATE INDEX "warehouse_gate_documents_docType_uploadedAt_idx" ON "warehouse_gate_documents"("docType", "uploadedAt");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_gate_passes_passNo_key" ON "warehouse_gate_passes"("passNo");

-- CreateIndex
CREATE INDEX "warehouse_gate_passes_gateEntryId_type_idx" ON "warehouse_gate_passes"("gateEntryId", "type");

-- CreateIndex
CREATE INDEX "warehouse_gate_events_shipmentId_at_idx" ON "warehouse_gate_events"("shipmentId", "at");

-- CreateIndex
CREATE INDEX "warehouse_gate_events_warehouseId_at_idx" ON "warehouse_gate_events"("warehouseId", "at" DESC);

-- CreateIndex
CREATE INDEX "warehouse_asns_warehouseId_etaAt_idx" ON "warehouse_asns"("warehouseId", "etaAt");

-- CreateIndex
CREATE INDEX "warehouse_asns_warehouseId_status_idx" ON "warehouse_asns"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "warehouse_asns_restockRequestId_idx" ON "warehouse_asns"("restockRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_asns_vendorId_vendorAsnRef_key" ON "warehouse_asns"("vendorId", "vendorAsnRef");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_gate_visitors_visitorNo_key" ON "warehouse_gate_visitors"("visitorNo");

-- CreateIndex
CREATE INDEX "warehouse_gate_visitors_warehouseId_createdAt_idx" ON "warehouse_gate_visitors"("warehouseId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_gate_visitors_warehouseId_status_idx" ON "warehouse_gate_visitors"("warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_gate_outward_materials_omNo_key" ON "warehouse_gate_outward_materials"("omNo");

-- CreateIndex
CREATE INDEX "warehouse_gate_outward_materials_warehouseId_createdAt_idx" ON "warehouse_gate_outward_materials"("warehouseId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_gate_outward_materials_warehouseId_status_idx" ON "warehouse_gate_outward_materials"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "warehouse_gate_security_checks_warehouseId_createdAt_idx" ON "warehouse_gate_security_checks"("warehouseId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_gate_security_checks_subjectId_idx" ON "warehouse_gate_security_checks"("subjectId");

-- AddForeignKey
ALTER TABLE "warehouse_inbound_lines" ADD CONSTRAINT "warehouse_inbound_lines_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "warehouse_inbound_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_gate_entry_receipts" ADD CONSTRAINT "warehouse_gate_entry_receipts_gateEntryId_fkey" FOREIGN KEY ("gateEntryId") REFERENCES "warehouse_gate_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_asn_lines" ADD CONSTRAINT "warehouse_asn_lines_asnId_fkey" FOREIGN KEY ("asnId") REFERENCES "warehouse_asns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written integrity (not expressible in the Prisma schema)
-- ─────────────────────────────────────────────────────────────────────────────

-- One ACTIVE gate entry per shipment, and a truck is "inside" once per warehouse. Both are freed at
-- EXITED (incl. outcome REJECTED) or CANCELLED, so a turned-away truck can gate-in again.
CREATE UNIQUE INDEX "warehouse_gate_entries_active_shipment_key"
  ON "warehouse_gate_entries" ("shipmentId") WHERE "status" NOT IN ('EXITED', 'CANCELLED');
CREATE UNIQUE INDEX "warehouse_gate_entries_active_vehicle_key"
  ON "warehouse_gate_entries" ("warehouseId", "vehicleRegNo") WHERE "status" NOT IN ('EXITED', 'CANCELLED');
CREATE INDEX "warehouse_gate_entries_no_receipt_idx"
  ON "warehouse_gate_entries" ("warehouseId", "exitedAt" DESC) WHERE "noReceipt";

-- One ACTIVE and one PENDING_APPROVAL reading per (entry, kind).
CREATE UNIQUE INDEX "warehouse_weighments_active_key"
  ON "warehouse_weighments" ("gateEntryId", "kind") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "warehouse_weighments_pending_key"
  ON "warehouse_weighments" ("gateEntryId", "kind") WHERE "status" = 'PENDING_APPROVAL';

-- One live (non-VOID) pass per (entry, type); a reissue voids the old one first.
CREATE UNIQUE INDEX "warehouse_gate_passes_live_key"
  ON "warehouse_gate_passes" ("gateEntryId", "type") WHERE "status" <> 'VOID';

-- Open security holds of a subject (exit guard).
CREATE INDEX "warehouse_gate_security_checks_open_hold_idx"
  ON "warehouse_gate_security_checks" ("subjectId") WHERE "result" = 'HOLD' AND "resolvedAt" IS NULL;

CREATE INDEX "warehouse_gate_events_entry_at_idx" ON "warehouse_gate_events" ("gateEntryId", "at");
CREATE INDEX "warehouse_weighments_pending_idx"
  ON "warehouse_weighments" ("warehouseId", "capturedAt" DESC) WHERE "status" = 'PENDING_APPROVAL';

-- Dashboard search (shipment no, vehicle, vendor, PO).
CREATE INDEX "warehouse_inbound_shipments_search_trgm_idx"
  ON "warehouse_inbound_shipments" USING gin ("searchText" gin_trgm_ops);

ALTER TABLE "warehouse_inbound_shipments"
  ADD CONSTRAINT "warehouse_inbound_shipments_units_chk" CHECK ("totalUnits" >= 0),
  ADD CONSTRAINT "warehouse_inbound_shipments_pallets_chk" CHECK ("palletCount" IS NULL OR "palletCount" >= 0),
  ADD CONSTRAINT "warehouse_inbound_shipments_weights_chk" CHECK (
    ("declaredNetKg" IS NULL OR "declaredNetKg" >= 0) AND
    ("invoiceNetKg" IS NULL OR "invoiceNetKg" > 0) AND
    ("invoiceGrossKg" IS NULL OR "invoiceGrossKg" > 0)
  );
ALTER TABLE "warehouse_inbound_lines"
  ADD CONSTRAINT "warehouse_inbound_lines_qty_chk" CHECK ("expectedQty" > 0);
ALTER TABLE "warehouse_gate_entries"
  ADD CONSTRAINT "warehouse_gate_entries_weights_chk" CHECK (
    ("grossKg" IS NULL OR "grossKg" > 0) AND
    ("tareKg" IS NULL OR "tareKg" > 0) AND
    ("exitCheckKg" IS NULL OR "exitCheckKg" > 0)
  ),
  ADD CONSTRAINT "warehouse_gate_entries_tare_chk" CHECK (
    "grossKg" IS NULL OR "tareKg" IS NULL OR "tareKg" < "grossKg"
  ),
  ADD CONSTRAINT "warehouse_gate_entries_outcome_chk" CHECK ("status" <> 'EXITED' OR "outcome" IS NOT NULL);
ALTER TABLE "warehouse_weighments"
  ADD CONSTRAINT "warehouse_weighments_weight_chk" CHECK ("weightKg" > 0);
ALTER TABLE "warehouse_weigh_scales"
  ADD CONSTRAINT "warehouse_weigh_scales_code_chk" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  ADD CONSTRAINT "warehouse_weigh_scales_limits_chk" CHECK ("maxCapacityKg" > 0 AND "divisionKg" > 0),
  ADD CONSTRAINT "warehouse_weigh_scales_calibration_chk" CHECK (
    "calibratedAt" IS NULL OR "calibrationValidUntil" IS NULL OR "calibrationValidUntil" >= "calibratedAt"
  );
ALTER TABLE "warehouse_asn_lines"
  ADD CONSTRAINT "warehouse_asn_lines_qty_chk" CHECK ("qty" > 0 AND "convertedQty" >= 0 AND "convertedQty" <= "qty");
ALTER TABLE "warehouse_gate_outward_materials"
  ADD CONSTRAINT "warehouse_gate_outward_materials_qty_chk" CHECK ("qty" > 0);

-- The gate timeline is append-only (same guard as the audit log).
CREATE TRIGGER "warehouse_gate_events_append_only" BEFORE UPDATE OR DELETE ON "warehouse_gate_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "warehouse_gate_events_no_truncate" BEFORE TRUNCATE ON "warehouse_gate_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
