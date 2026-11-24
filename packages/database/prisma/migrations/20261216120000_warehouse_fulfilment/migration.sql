-- CreateEnum
CREATE TYPE "WmsComplianceCheckType" AS ENUM ('VET_RX', 'DRUG_LICENCE', 'RESTRICTED_PERMIT', 'FARMER_DECLARATION', 'COA');

-- CreateEnum
CREATE TYPE "WmsComplianceCheckStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'WAIVED');

-- CreateEnum
CREATE TYPE "WmsVerificationMethod" AS ENUM ('MANUAL', 'AUTO_COA', 'AUTO_PORTAL', 'OCR');

-- CreateEnum
CREATE TYPE "WmsEvidenceType" AS ENUM ('RX_SCAN', 'LICENCE', 'DECLARATION', 'OTHER');

-- CreateEnum
CREATE TYPE "WmsShipmentStatus" AS ENUM ('PENDING_RELEASE', 'RELEASED', 'ALLOCATED', 'ASSIGNED', 'PICKING', 'PACKING', 'QC', 'READY_TO_DISPATCH', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FULFILLED', 'DELIVERY_FAILED', 'RETURNED_TO_WAREHOUSE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WmsShipmentPriority" AS ENUM ('STANDARD', 'PRIORITY');

-- CreateEnum
CREATE TYPE "WmsDeliveryType" AS ENUM ('STANDARD', 'EXPRESS', 'BULK');

-- CreateEnum
CREATE TYPE "WmsLotAllocationStatus" AS ENUM ('ALLOCATED', 'PICKED', 'PACKED', 'ISSUED', 'RELEASED');

-- CreateEnum
CREATE TYPE "WmsTaskType" AS ENUM ('PICK_PACK', 'PUTAWAY');

-- CreateEnum
CREATE TYPE "WmsTaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WmsPickBatchStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "WmsPackageType" AS ENUM ('BAG', 'BOX', 'PALLET', 'DRUM', 'CAN', 'CASK', 'TANK');

-- CreateEnum
CREATE TYPE "WmsQcResult" AS ENUM ('PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "WmsHoldReason" AS ENUM ('CUSTOMER_REQUEST', 'PAYMENT_ISSUE', 'COMPLIANCE', 'QUALITY', 'OPERATIONS', 'OTHER');

-- CreateEnum
CREATE TYPE "WmsExceptionType" AS ENUM ('SHORTAGE', 'PARTIAL', 'CANCELLATION', 'ALLOCATION_ISSUE', 'QUALITY', 'DELIVERY', 'STOCK_DRIFT', 'ALLOCATION_MISMATCH', 'ISSUE_MISMATCH');

-- CreateEnum
CREATE TYPE "WmsExceptionCause" AS ENUM ('STOCK_SHORT', 'COLD_BREACH', 'DAMAGED', 'QC_FAIL', 'UNBINNED_STOCK', 'ZERO_STOCK_AT_NODE', 'CUSTOMER_CANCEL', 'DRIFT', 'OTHER');

-- CreateEnum
CREATE TYPE "WmsSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "WmsExceptionStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WmsReallocationStatus" AS ENUM ('PENDING', 'INVENTORY_DONE', 'COMPLETED', 'FAILED', 'COMPENSATED');

-- CreateEnum
CREATE TYPE "WmsComplianceStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'FLAGGED', 'APPROVED', 'REJECTED', 'ON_HOLD');

-- CreateTable
CREATE TABLE "warehouse_compliance_rules" (
    "key" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "appliesWhen" JSONB NOT NULL,
    "requiredChecks" "WmsComplianceCheckType"[],
    "legalBasis" VARCHAR(200),
    "periodLimitQty" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_compliance_rules_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "warehouse_compliance_cases" (
    "id" UUID NOT NULL,
    "caseNo" VARCHAR(20) NOT NULL,
    "orderId" UUID NOT NULL,
    "warehouseId" UUID,
    "status" "WmsComplianceStatus" NOT NULL DEFAULT 'PENDING',
    "inspectorUserId" UUID,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "restrictedCount" INTEGER NOT NULL DEFAULT 0,
    "skuCount" INTEGER NOT NULL DEFAULT 0,
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "decidedBy" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_compliance_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_compliance_checks" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "type" "WmsComplianceCheckType" NOT NULL,
    "ruleKey" VARCHAR(40),
    "lineNos" INTEGER[],
    "status" "WmsComplianceCheckStatus" NOT NULL DEFAULT 'PENDING',
    "legalBasis" VARCHAR(200),
    "documentNo" VARCHAR(60),
    "issuerName" VARCHAR(120),
    "issuerRegNo" VARCHAR(60),
    "validUntil" DATE,
    "verificationMethod" "WmsVerificationMethod",
    "qtyLabel" VARCHAR(80),
    "mediaKeys" TEXT[],
    "uploadedBy" UUID,
    "verifiedBy" UUID,
    "verifiedAt" TIMESTAMP(3),
    "note" VARCHAR(500),
    "requestedAt" TIMESTAMP(3),
    "requestedVia" VARCHAR(20),

    CONSTRAINT "warehouse_compliance_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_compliance_evidence" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "checkId" UUID,
    "docType" "WmsEvidenceType" NOT NULL,
    "mediaKey" VARCHAR(300) NOT NULL,
    "note" VARCHAR(500),
    "uploadedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_compliance_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_compliance_notes" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_compliance_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_compliance_inspectors" (
    "userId" UUID NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "title" VARCHAR(120),
    "govtRegNo" VARCHAR(60),
    "photoMediaKey" VARCHAR(300),
    "onDuty" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_compliance_inspectors_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "warehouse_compliance_waivers" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "authorizationNo" VARCHAR(60) NOT NULL,
    "receipt" VARCHAR(300),
    "checkIds" TEXT[],
    "waivedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_compliance_waivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_orders" (
    "orderId" UUID NOT NULL,
    "orderNo" VARCHAR(30) NOT NULL,
    "reservationId" UUID,
    "userId" UUID,
    "farmId" UUID,
    "channel" VARCHAR(12),
    "customerName" VARCHAR(120),
    "customerPhone" VARCHAR(20),
    "farmName" VARCHAR(160),
    "farmCode" VARCHAR(30),
    "segment" VARCHAR(60),
    "customerPoRef" VARCHAR(40),
    "shipTo" JSONB,
    "district" VARCHAR(80),
    "stateCode" VARCHAR(4),
    "pinCode" CHAR(6),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "orderStatus" VARCHAR(30) NOT NULL,
    "paymentStatus" VARCHAR(20) NOT NULL,
    "paymentMethod" VARCHAR(12),
    "paymentInstrument" VARCHAR(20),
    "paymentRefMasked" VARCHAR(20),
    "refundStatus" VARCHAR(24),
    "grandTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totals" JSONB,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "unitCount" INTEGER NOT NULL DEFAULT 0,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "promisedBy" TIMESTAMP(3),
    "complianceStatus" "WmsComplianceStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "holdActive" BOOLEAN NOT NULL DEFAULT false,
    "autoAllocated" BOOLEAN NOT NULL DEFAULT true,
    "routingRuleId" UUID,
    "factsLoaded" BOOLEAN NOT NULL DEFAULT false,
    "searchText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_orders_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "warehouse_order_lines" (
    "orderId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" UUID NOT NULL,
    "productId" UUID,
    "sku" VARCHAR(40),
    "name" VARCHAR(250),
    "temperatureClass" VARCHAR(10),
    "qty" INTEGER NOT NULL,
    "cancelledQty" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_order_lines_pkey" PRIMARY KEY ("orderId","lineNo")
);

-- CreateTable
CREATE TABLE "warehouse_shipments" (
    "id" UUID NOT NULL,
    "shipmentNo" VARCHAR(20) NOT NULL,
    "orderId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" "WmsShipmentStatus" NOT NULL DEFAULT 'PENDING_RELEASE',
    "priority" "WmsShipmentPriority" NOT NULL DEFAULT 'STANDARD',
    "deliveryType" "WmsDeliveryType" NOT NULL DEFAULT 'STANDARD',
    "isBulk" BOOLEAN NOT NULL DEFAULT false,
    "holdActive" BOOLEAN NOT NULL DEFAULT false,
    "atRisk" BOOLEAN NOT NULL DEFAULT false,
    "coldRequired" BOOLEAN NOT NULL DEFAULT false,
    "slaDueAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "allocatedAt" TIMESTAMP(3),
    "assignedAt" TIMESTAMP(3),
    "pickStartedAt" TIMESTAMP(3),
    "pickedAt" TIMESTAMP(3),
    "packedAt" TIMESTAMP(3),
    "qcPassedAt" TIMESTAMP(3),
    "stagedAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "outForDeliveryAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "stagingAreaId" UUID,
    "palletCount" INTEGER NOT NULL DEFAULT 0,
    "routeId" UUID,
    "dockBookingId" UUID,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "unitCount" INTEGER NOT NULL DEFAULT 0,
    "weightKg" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "qcFirstPass" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_shipment_lines" (
    "shipmentId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "orderLineNo" INTEGER,
    "variantId" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "allocatedQty" INTEGER NOT NULL DEFAULT 0,
    "pickedQty" INTEGER NOT NULL DEFAULT 0,
    "packedQty" INTEGER NOT NULL DEFAULT 0,
    "dispatchedQty" INTEGER NOT NULL DEFAULT 0,
    "deliveredQty" INTEGER NOT NULL DEFAULT 0,
    "cancelledQty" INTEGER NOT NULL DEFAULT 0,
    "backorderedQty" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reallocationId" UUID,

    CONSTRAINT "warehouse_shipment_lines_pkey" PRIMARY KEY ("shipmentId","lineNo")
);

-- CreateTable
CREATE TABLE "warehouse_lot_allocations" (
    "id" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "warehouseId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "binId" UUID,
    "qty" INTEGER NOT NULL,
    "pickedQty" INTEGER NOT NULL DEFAULT 0,
    "status" "WmsLotAllocationStatus" NOT NULL DEFAULT 'ALLOCATED',
    "isFefo" BOOLEAN NOT NULL DEFAULT true,
    "overrideReason" VARCHAR(300),
    "soft" BOOLEAN NOT NULL DEFAULT false,
    "allocatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" VARCHAR(200),

    CONSTRAINT "warehouse_lot_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_shipment_events" (
    "id" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" VARCHAR(30),
    "toStatus" VARCHAR(30) NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "actorType" VARCHAR(10) NOT NULL,
    "actorId" UUID,
    "note" VARCHAR(500),
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_pick_batches" (
    "id" UUID NOT NULL,
    "batchNo" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" "WmsPickBatchStatus" NOT NULL DEFAULT 'OPEN',
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "warehouse_pick_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_tasks" (
    "id" UUID NOT NULL,
    "taskNo" VARCHAR(20) NOT NULL,
    "shipmentId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "type" "WmsTaskType" NOT NULL DEFAULT 'PICK_PACK',
    "assigneeUserId" UUID,
    "priority" "WmsShipmentPriority" NOT NULL DEFAULT 'STANDARD',
    "deadlineAt" TIMESTAMP(3),
    "status" "WmsTaskStatus" NOT NULL DEFAULT 'OPEN',
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "pickBatchId" UUID,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_packages" (
    "id" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "boxNo" INTEGER NOT NULL,
    "packageType" "WmsPackageType" NOT NULL DEFAULT 'BOX',
    "weightKg" DECIMAL(10,3),
    "sealed" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_qc_checks" (
    "id" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "checks" JSONB NOT NULL,
    "tempC" DECIMAL(5,2),
    "result" "WmsQcResult" NOT NULL,
    "note" VARCHAR(500),
    "checkedBy" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_qc_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_holds" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "reasonCode" "WmsHoldReason" NOT NULL,
    "note" VARCHAR(500),
    "placedBy" UUID,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "autoReleaseAt" TIMESTAMP(3),
    "keepAllocationUntil" TIMESTAMP(3),
    "releasedBy" UUID,
    "releasedAt" TIMESTAMP(3),
    "releaseNote" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_exceptions" (
    "id" UUID NOT NULL,
    "exNo" VARCHAR(20) NOT NULL,
    "type" "WmsExceptionType" NOT NULL,
    "cause" "WmsExceptionCause",
    "severity" "WmsSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "WmsExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "orderId" UUID,
    "shipmentId" UUID,
    "warehouseId" UUID NOT NULL,
    "variantId" UUID,
    "batchId" UUID,
    "requiredQty" INTEGER NOT NULL DEFAULT 0,
    "availableQty" INTEGER NOT NULL DEFAULT 0,
    "impactedQty" INTEGER NOT NULL DEFAULT 0,
    "impactedKg" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reportedLocation" VARCHAR(60),
    "expectedRef" VARCHAR(60),
    "title" VARCHAR(200) NOT NULL,
    "diagnostic" JSONB NOT NULL DEFAULT '{}',
    "proposal" JSONB NOT NULL DEFAULT '{}',
    "resolution" JSONB,
    "slaDueAt" TIMESTAMP(3),
    "reportedBy" UUID,
    "assignedTo" UUID,
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMP(3),
    "dedupeKey" VARCHAR(120),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_reallocations" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromWarehouseId" UUID NOT NULL,
    "toWarehouseId" UUID NOT NULL,
    "lines" JSONB NOT NULL,
    "status" "WmsReallocationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "reason" VARCHAR(500) NOT NULL,
    "requestedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_reallocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_fulfilment_daily" (
    "warehouseId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "received" INTEGER NOT NULL DEFAULT 0,
    "released" INTEGER NOT NULL DEFAULT 0,
    "dispatched" INTEGER NOT NULL DEFAULT 0,
    "onTimeDispatch" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "onTimeDelivery" INTEGER NOT NULL DEFAULT 0,
    "fulfilled" INTEGER NOT NULL DEFAULT 0,
    "cancelled" INTEGER NOT NULL DEFAULT 0,
    "cycleMinSum" BIGINT NOT NULL DEFAULT 0,
    "pickToPackMinSum" BIGINT NOT NULL DEFAULT 0,
    "pickToPackCount" INTEGER NOT NULL DEFAULT 0,
    "qcFirst" INTEGER NOT NULL DEFAULT 0,
    "qcTotal" INTEGER NOT NULL DEFAULT 0,
    "exceptionsOpened" INTEGER NOT NULL DEFAULT 0,
    "valueFulfilled" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_fulfilment_daily_pkey" PRIMARY KEY ("warehouseId","day")
);

-- CreateTable
CREATE TABLE "warehouse_shelf_life_rules" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "stateCode" VARCHAR(4),
    "rootCategoryId" UUID,
    "farmCategory" VARCHAR(60),
    "minRemainingDays" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_shelf_life_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_compliance_cases_caseNo_key" ON "warehouse_compliance_cases"("caseNo");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_compliance_cases_orderId_key" ON "warehouse_compliance_cases"("orderId");

-- CreateIndex
CREATE INDEX "warehouse_compliance_cases_status_slaDueAt_idx" ON "warehouse_compliance_cases"("status", "slaDueAt");

-- CreateIndex
CREATE INDEX "warehouse_compliance_cases_warehouseId_status_idx" ON "warehouse_compliance_cases"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "warehouse_compliance_checks_caseId_idx" ON "warehouse_compliance_checks"("caseId");

-- CreateIndex
CREATE INDEX "warehouse_compliance_evidence_caseId_createdAt_idx" ON "warehouse_compliance_evidence"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "warehouse_compliance_notes_caseId_createdAt_idx" ON "warehouse_compliance_notes"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "warehouse_compliance_waivers_caseId_idx" ON "warehouse_compliance_waivers"("caseId");

-- CreateIndex
CREATE INDEX "warehouse_orders_placedAt_orderId_idx" ON "warehouse_orders"("placedAt" DESC, "orderId");

-- CreateIndex
CREATE INDEX "warehouse_orders_paymentStatus_placedAt_idx" ON "warehouse_orders"("paymentStatus", "placedAt");

-- CreateIndex
CREATE INDEX "warehouse_orders_pinCode_idx" ON "warehouse_orders"("pinCode");

-- CreateIndex
CREATE INDEX "warehouse_order_lines_variantId_idx" ON "warehouse_order_lines"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_shipments_shipmentNo_key" ON "warehouse_shipments"("shipmentNo");

-- CreateIndex
CREATE INDEX "warehouse_shipments_warehouseId_status_slaDueAt_idx" ON "warehouse_shipments"("warehouseId", "status", "slaDueAt");

-- CreateIndex
CREATE INDEX "warehouse_shipments_warehouseId_deliveredAt_idx" ON "warehouse_shipments"("warehouseId", "deliveredAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_shipments_warehouseId_fulfilledAt_idx" ON "warehouse_shipments"("warehouseId", "fulfilledAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_shipments_status_slaDueAt_idx" ON "warehouse_shipments"("status", "slaDueAt");

-- CreateIndex
CREATE INDEX "warehouse_shipments_warehouseId_createdAt_idx" ON "warehouse_shipments"("warehouseId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_shipments_orderId_warehouseId_key" ON "warehouse_shipments"("orderId", "warehouseId");

-- CreateIndex
CREATE INDEX "warehouse_shipment_lines_variantId_idx" ON "warehouse_shipment_lines"("variantId");

-- CreateIndex
CREATE INDEX "warehouse_lot_allocations_shipmentId_lineNo_idx" ON "warehouse_lot_allocations"("shipmentId", "lineNo");

-- CreateIndex
CREATE INDEX "warehouse_lot_allocations_batchId_status_idx" ON "warehouse_lot_allocations"("batchId", "status");

-- CreateIndex
CREATE INDEX "warehouse_lot_allocations_warehouseId_variantId_status_idx" ON "warehouse_lot_allocations"("warehouseId", "variantId", "status");

-- CreateIndex
CREATE INDEX "warehouse_lot_allocations_warehouseId_status_createdAt_idx" ON "warehouse_lot_allocations"("warehouseId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_shipment_events_shipmentId_at_idx" ON "warehouse_shipment_events"("shipmentId", "at");

-- CreateIndex
CREATE INDEX "warehouse_shipment_events_orderId_at_idx" ON "warehouse_shipment_events"("orderId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_pick_batches_batchNo_key" ON "warehouse_pick_batches"("batchNo");

-- CreateIndex
CREATE INDEX "warehouse_pick_batches_warehouseId_status_idx" ON "warehouse_pick_batches"("warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_tasks_taskNo_key" ON "warehouse_tasks"("taskNo");

-- CreateIndex
CREATE INDEX "warehouse_tasks_warehouseId_assigneeUserId_status_idx" ON "warehouse_tasks"("warehouseId", "assigneeUserId", "status");

-- CreateIndex
CREATE INDEX "warehouse_tasks_shipmentId_idx" ON "warehouse_tasks"("shipmentId");

-- CreateIndex
CREATE INDEX "warehouse_tasks_pickBatchId_idx" ON "warehouse_tasks"("pickBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_packages_shipmentId_boxNo_key" ON "warehouse_packages"("shipmentId", "boxNo");

-- CreateIndex
CREATE INDEX "warehouse_qc_checks_at_idx" ON "warehouse_qc_checks"("at");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_qc_checks_shipmentId_attempt_key" ON "warehouse_qc_checks"("shipmentId", "attempt");

-- CreateIndex
CREATE INDEX "warehouse_holds_orderId_placedAt_idx" ON "warehouse_holds"("orderId", "placedAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_holds_autoReleaseAt_idx" ON "warehouse_holds"("autoReleaseAt");

-- CreateIndex
CREATE INDEX "warehouse_holds_keepAllocationUntil_idx" ON "warehouse_holds"("keepAllocationUntil");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_exceptions_exNo_key" ON "warehouse_exceptions"("exNo");

-- CreateIndex
CREATE INDEX "warehouse_exceptions_warehouseId_status_type_slaDueAt_idx" ON "warehouse_exceptions"("warehouseId", "status", "type", "slaDueAt");

-- CreateIndex
CREATE INDEX "warehouse_exceptions_orderId_idx" ON "warehouse_exceptions"("orderId");

-- CreateIndex
CREATE INDEX "warehouse_exceptions_status_createdAt_idx" ON "warehouse_exceptions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "warehouse_reallocations_status_updatedAt_idx" ON "warehouse_reallocations"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "warehouse_reallocations_orderId_idx" ON "warehouse_reallocations"("orderId");

-- CreateIndex
CREATE INDEX "warehouse_fulfilment_daily_day_idx" ON "warehouse_fulfilment_daily"("day");

-- AddForeignKey
ALTER TABLE "warehouse_compliance_checks" ADD CONSTRAINT "warehouse_compliance_checks_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "warehouse_compliance_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_order_lines" ADD CONSTRAINT "warehouse_order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "warehouse_orders"("orderId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_shipment_lines" ADD CONSTRAINT "warehouse_shipment_lines_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "warehouse_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-written (D-57b Phase 3) ──
-- Order search (order no, customer, farm, PIN, PO ref).
CREATE INDEX "warehouse_orders_search_trgm_idx" ON "warehouse_orders" USING GIN ("searchText" gin_trgm_ops);

-- One open hold per order; one open exception per dedupe key.
CREATE UNIQUE INDEX "warehouse_holds_one_open_key" ON "warehouse_holds" ("orderId") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "warehouse_exceptions_dedupe_open_key" ON "warehouse_exceptions" ("dedupeKey")
  WHERE "dedupeKey" IS NOT NULL AND "status" IN ('OPEN', 'IN_REVIEW');

-- Quantities never go negative or past the line.
ALTER TABLE "warehouse_shipment_lines" ADD CONSTRAINT "warehouse_shipment_lines_qty_check" CHECK (
  "qty" >= 0 AND "allocatedQty" >= 0 AND "pickedQty" >= 0 AND "packedQty" >= 0 AND "dispatchedQty" >= 0
  AND "deliveredQty" >= 0 AND "cancelledQty" >= 0 AND "backorderedQty" >= 0
  AND "allocatedQty" <= "qty" AND "pickedQty" <= "qty" AND "packedQty" <= "qty");
ALTER TABLE "warehouse_lot_allocations" ADD CONSTRAINT "warehouse_lot_allocations_qty_check" CHECK (
  "qty" > 0 AND "pickedQty" >= 0 AND "pickedQty" <= "qty");

-- The shipment timeline is append-only.
CREATE TRIGGER "warehouse_shipment_events_no_update" BEFORE UPDATE OR DELETE ON "warehouse_shipment_events"
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER "warehouse_shipment_events_no_truncate" BEFORE TRUNCATE ON "warehouse_shipment_events"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

-- Regulatory registry defaults (open item 5): Schedule H/H1/X and antimicrobials need a vet Rx;
-- hazardous products need a restricted permit and a farmer declaration.
INSERT INTO "warehouse_compliance_rules" ("key", "name", "appliesWhen", "requiredChecks", "legalBasis", "updatedAt") VALUES
  ('SCHEDULE_H', 'Prescription drugs (Schedule H / H1 / X)', '{"drugSchedules":["H","H1","X"]}',
     ARRAY['VET_RX']::"WmsComplianceCheckType"[], 'Drugs & Cosmetics Act (Sch. H / H1)', now()),
  ('ANTIMICROBIAL', 'Antimicrobials', '{"antimicrobial":true}',
     ARRAY['VET_RX']::"WmsComplianceCheckType"[], 'Drugs & Cosmetics Act (Sch. H1)', now()),
  ('VET_CONSULT', 'Vet consultation required', '{"vetConsult":true}',
     ARRAY['VET_RX']::"WmsComplianceCheckType"[], NULL, now()),
  ('HAZARDOUS', 'Hazardous / restricted chemicals', '{"hazardous":true}',
     ARRAY['RESTRICTED_PERMIT', 'FARMER_DECLARATION']::"WmsComplianceCheckType"[], 'Insecticide Act Schedule 1', now());
