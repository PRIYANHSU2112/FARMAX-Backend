-- CreateEnum
CREATE TYPE "WmsStockStatus" AS ENUM ('RECEIVED', 'QC_HOLD', 'AVAILABLE', 'RESERVED', 'PICKED', 'PACKED', 'DISPATCHED', 'DELIVERED', 'QUARANTINED', 'DAMAGED', 'EXPIRED', 'IN_TRANSIT', 'RETURNED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "WmsOwnerType" AS ENUM ('SOR', 'FARMX', 'JIT');

-- CreateEnum
CREATE TYPE "WmsMovementType" AS ENUM ('RECEIPT', 'OPENING', 'QC_RELEASE', 'QC_HOLD', 'ALLOCATE', 'DEALLOCATE', 'PICK', 'PACK', 'ISSUE', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN', 'RESTOCK', 'ADJUSTMENT', 'DAMAGE', 'QUARANTINE', 'EXPIRE', 'WRITE_OFF', 'BIN_MOVE', 'OWNER_FIX', 'RELABEL', 'ROLLBACK_REPLAY', 'STATUS_CHANGE');

-- CreateEnum
CREATE TYPE "WmsCertificateStatus" AS ENUM ('NONE', 'SAMPLE_REFERENCE', 'VALID', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WmsReceiptSource" AS ENUM ('VENDOR', 'TRANSFER', 'RETURN', 'OPENING');

-- CreateEnum
CREATE TYPE "WmsApprovalStatus" AS ENUM ('PENDING_APPROVAL', 'APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WmsProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WmsRestockType" AS ENUM ('PROCUREMENT', 'TRANSFER');

-- CreateEnum
CREATE TYPE "WmsRestockStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "WmsTransferStatus" AS ENUM ('IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "warehouse_variant_projection" (
    "variantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "name" VARCHAR(250) NOT NULL,
    "variantName" VARCHAR(250) NOT NULL,
    "brandId" UUID NOT NULL,
    "brandName" VARCHAR(80),
    "categoryId" UUID NOT NULL,
    "categoryPath" UUID[],
    "rootCategoryId" UUID,
    "packLabel" VARCHAR(60) NOT NULL,
    "weightGrams" INTEGER,
    "temperatureClass" VARCHAR(10) NOT NULL DEFAULT 'AMB',
    "shelfLifeMonths" INTEGER,
    "imageUrl" VARCHAR(500),
    "isPrescriptionRequired" BOOLEAN NOT NULL DEFAULT false,
    "drugSchedule" VARCHAR(4),
    "isAntimicrobial" BOOLEAN NOT NULL DEFAULT false,
    "hazardClass" VARCHAR(40),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" BIGINT NOT NULL DEFAULT -1,
    "searchText" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_variant_projection_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "warehouse_vendors" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "gstin" VARCHAR(15),
    "phone" VARCHAR(16),
    "email" VARCHAR(254),
    "defaultOwnership" "WmsOwnerType" NOT NULL DEFAULT 'FARMX',
    "status" "WmsResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_vendor_variants" (
    "vendorId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "ownershipModel" "WmsOwnerType" NOT NULL,
    "leadTimeDays" SMALLINT NOT NULL DEFAULT 7,
    "moq" INTEGER NOT NULL DEFAULT 1,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "requiresUnitQr" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_vendor_variants_pkey" PRIMARY KEY ("vendorId","variantId")
);

-- CreateTable
CREATE TABLE "warehouse_batches" (
    "id" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "batchNo" VARCHAR(40) NOT NULL,
    "mfgDate" DATE,
    "expiryDate" DATE,
    "vendorId" UUID,
    "coaRef" VARCHAR(60),
    "coaMediaKey" VARCHAR(300),
    "certificateStatus" "WmsCertificateStatus" NOT NULL DEFAULT 'NONE',
    "qualityNote" VARCHAR(500),
    "isOpening" BOOLEAN NOT NULL DEFAULT false,
    "serialized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stock_positions" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "binId" UUID,
    "ownerType" "WmsOwnerType" NOT NULL,
    "vendorId" UUID,
    "qcHold" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "picked" INTEGER NOT NULL DEFAULT 0,
    "packed" INTEGER NOT NULL DEFAULT 0,
    "quarantined" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "returned" INTEGER NOT NULL DEFAULT 0,
    "expiryDate" DATE,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stock_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stock_summary" (
    "warehouseId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "qcHold" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "picked" INTEGER NOT NULL DEFAULT 0,
    "packed" INTEGER NOT NULL DEFAULT 0,
    "quarantined" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "returned" INTEGER NOT NULL DEFAULT 0,
    "nearExpiry" INTEGER NOT NULL DEFAULT 0,
    "expiryUnknown" INTEGER NOT NULL DEFAULT 0,
    "lastMovementAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stock_summary_pkey" PRIMARY KEY ("warehouseId","variantId")
);

-- CreateTable
CREATE TABLE "warehouse_stock_movements" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "binId" UUID,
    "ownerType" "WmsOwnerType" NOT NULL,
    "type" "WmsMovementType" NOT NULL,
    "fromStatus" "WmsStockStatus",
    "toStatus" "WmsStockStatus",
    "qty" INTEGER NOT NULL,
    "sellableDelta" INTEGER NOT NULL DEFAULT 0,
    "damagedDelta" INTEGER NOT NULL DEFAULT 0,
    "refType" VARCHAR(20) NOT NULL,
    "refId" UUID,
    "refNo" VARCHAR(40),
    "reason" VARCHAR(500),
    "actorUserId" UUID,
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stock_units" (
    "qrCode" VARCHAR(64) NOT NULL,
    "batchId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "warehouseId" UUID,
    "binId" UUID,
    "status" "WmsStockStatus" NOT NULL,
    "seq" INTEGER NOT NULL,
    "ownerType" "WmsOwnerType" NOT NULL,
    "shipmentId" UUID,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_stock_units_pkey" PRIMARY KEY ("qrCode")
);

-- CreateTable
CREATE TABLE "warehouse_receipts" (
    "id" UUID NOT NULL,
    "cnNo" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "sourceType" "WmsReceiptSource" NOT NULL,
    "vendorId" UUID,
    "restockRequestId" UUID,
    "transferId" UUID,
    "notes" VARCHAR(500),
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" UUID,

    CONSTRAINT "warehouse_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_receipt_lines" (
    "receiptId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "binId" UUID,
    "qty" INTEGER NOT NULL,
    "ownerType" "WmsOwnerType" NOT NULL,
    "vendorId" UUID,
    "initialStatus" "WmsStockStatus" NOT NULL,

    CONSTRAINT "warehouse_receipt_lines_pkey" PRIMARY KEY ("receiptId","lineNo")
);

-- CreateTable
CREATE TABLE "warehouse_stock_adjustments" (
    "id" UUID NOT NULL,
    "adjNo" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "lines" JSONB NOT NULL,
    "totalUnits" INTEGER NOT NULL,
    "reasonCode" VARCHAR(40) NOT NULL,
    "note" VARCHAR(500),
    "status" "WmsApprovalStatus" NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "requestedBy" UUID NOT NULL,
    "decidedBy" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_stock_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_status_transitions" (
    "fromStatus" "WmsStockStatus" NOT NULL,
    "toStatus" "WmsStockStatus" NOT NULL,
    "requiredEvent" VARCHAR(120) NOT NULL,
    "roleLabel" VARCHAR(80) NOT NULL,
    "permissionKey" VARCHAR(60),
    "systemOnly" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_status_transitions_pkey" PRIMARY KEY ("fromStatus","toStatus")
);

-- CreateTable
CREATE TABLE "warehouse_transition_proposals" (
    "id" UUID NOT NULL,
    "fromStatus" "WmsStockStatus" NOT NULL,
    "toStatus" "WmsStockStatus" NOT NULL,
    "action" VARCHAR(8) NOT NULL DEFAULT 'ADD',
    "reasonEvent" VARCHAR(500) NOT NULL,
    "roleLabel" VARCHAR(80),
    "status" "WmsProposalStatus" NOT NULL DEFAULT 'PENDING',
    "proposedBy" UUID NOT NULL,
    "decidedBy" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_transition_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stock_thresholds" (
    "warehouseId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "safetyStock" INTEGER NOT NULL DEFAULT 0,
    "reorderLevel" INTEGER NOT NULL DEFAULT 0,
    "targetStock" INTEGER NOT NULL DEFAULT 0,
    "updatedByUserId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stock_thresholds_pkey" PRIMARY KEY ("warehouseId","variantId")
);

-- CreateTable
CREATE TABLE "warehouse_settings" (
    "key" VARCHAR(60) NOT NULL,
    "scope" VARCHAR(40) NOT NULL DEFAULT 'GLOBAL',
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_settings_pkey" PRIMARY KEY ("key","scope")
);

-- CreateTable
CREATE TABLE "warehouse_sequences" (
    "kind" VARCHAR(8) NOT NULL,
    "period" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_sequences_pkey" PRIMARY KEY ("kind","period")
);

-- CreateTable
CREATE TABLE "warehouse_restock_requests" (
    "id" UUID NOT NULL,
    "requestNo" VARCHAR(20) NOT NULL,
    "type" "WmsRestockType" NOT NULL,
    "destWarehouseId" UUID NOT NULL,
    "sourceWarehouseId" UUID,
    "vendorId" UUID,
    "requiredBy" DATE NOT NULL,
    "periodMonth" DATE NOT NULL,
    "notes" VARCHAR(500),
    "status" "WmsRestockStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" UUID NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" UUID,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" UUID,
    "decisionNote" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_restock_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_restock_lines" (
    "requestId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "availableAtRequest" INTEGER NOT NULL DEFAULT 0,
    "suggestedQty" INTEGER NOT NULL DEFAULT 0,
    "requestedQty" INTEGER NOT NULL,
    "approvedQty" INTEGER,
    "dispatchedQty" INTEGER NOT NULL DEFAULT 0,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_restock_lines_pkey" PRIMARY KEY ("requestId","variantId")
);

-- CreateTable
CREATE TABLE "warehouse_transfers" (
    "id" UUID NOT NULL,
    "trNo" VARCHAR(20) NOT NULL,
    "restockRequestId" UUID,
    "sourceWarehouseId" UUID NOT NULL,
    "destWarehouseId" UUID NOT NULL,
    "status" "WmsTransferStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedBy" UUID,
    "etaAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "receivedBy" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_transfer_lines" (
    "transferId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "ownerType" "WmsOwnerType" NOT NULL,
    "vendorId" UUID,
    "qty" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_transfer_lines_pkey" PRIMARY KEY ("transferId","lineNo")
);

-- CreateIndex
CREATE INDEX "warehouse_variant_projection_rootCategoryId_idx" ON "warehouse_variant_projection"("rootCategoryId");

-- CreateIndex
CREATE INDEX "warehouse_variant_projection_brandId_idx" ON "warehouse_variant_projection"("brandId");

-- CreateIndex
CREATE INDEX "warehouse_variant_projection_sku_idx" ON "warehouse_variant_projection"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_vendors_code_key" ON "warehouse_vendors"("code");

-- CreateIndex
CREATE INDEX "warehouse_vendors_name_idx" ON "warehouse_vendors"("name");

-- CreateIndex
CREATE INDEX "warehouse_vendor_variants_variantId_idx" ON "warehouse_vendor_variants"("variantId");

-- CreateIndex
CREATE INDEX "warehouse_batches_expiryDate_idx" ON "warehouse_batches"("expiryDate");

-- CreateIndex
CREATE INDEX "warehouse_batches_batchNo_idx" ON "warehouse_batches"("batchNo");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_batches_variantId_batchNo_key" ON "warehouse_batches"("variantId", "batchNo");

-- CreateIndex
CREATE INDEX "warehouse_stock_positions_warehouseId_variantId_idx" ON "warehouse_stock_positions"("warehouseId", "variantId");

-- CreateIndex
CREATE INDEX "warehouse_stock_positions_batchId_idx" ON "warehouse_stock_positions"("batchId");

-- CreateIndex
CREATE INDEX "warehouse_stock_positions_binId_idx" ON "warehouse_stock_positions"("binId");

-- CreateIndex
CREATE INDEX "warehouse_stock_positions_warehouseId_expiryDate_id_idx" ON "warehouse_stock_positions"("warehouseId", "expiryDate", "id");

-- CreateIndex
CREATE INDEX "warehouse_stock_positions_expiryDate_id_idx" ON "warehouse_stock_positions"("expiryDate", "id");

-- CreateIndex
CREATE INDEX "warehouse_stock_summary_warehouseId_available_idx" ON "warehouse_stock_summary"("warehouseId", "available");

-- CreateIndex
CREATE INDEX "warehouse_stock_summary_variantId_idx" ON "warehouse_stock_summary"("variantId");

-- CreateIndex
CREATE INDEX "warehouse_stock_movements_warehouseId_createdAt_id_idx" ON "warehouse_stock_movements"("warehouseId", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "warehouse_stock_movements_variantId_createdAt_idx" ON "warehouse_stock_movements"("variantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_stock_movements_batchId_createdAt_idx" ON "warehouse_stock_movements"("batchId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_stock_movements_refType_refId_idx" ON "warehouse_stock_movements"("refType", "refId");

-- CreateIndex
CREATE INDEX "warehouse_stock_movements_type_createdAt_idx" ON "warehouse_stock_movements"("type", "createdAt");

-- CreateIndex
CREATE INDEX "warehouse_stock_units_batchId_warehouseId_status_seq_idx" ON "warehouse_stock_units"("batchId", "warehouseId", "status", "seq");

-- CreateIndex
CREATE INDEX "warehouse_stock_units_shipmentId_idx" ON "warehouse_stock_units"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stock_units_batchId_seq_key" ON "warehouse_stock_units"("batchId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_receipts_cnNo_key" ON "warehouse_receipts"("cnNo");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_receipts_idempotencyKey_key" ON "warehouse_receipts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "warehouse_receipts_warehouseId_receivedAt_idx" ON "warehouse_receipts"("warehouseId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_receipt_lines_batchId_idx" ON "warehouse_receipt_lines"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stock_adjustments_adjNo_key" ON "warehouse_stock_adjustments"("adjNo");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stock_adjustments_idempotencyKey_key" ON "warehouse_stock_adjustments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "warehouse_stock_adjustments_warehouseId_status_createdAt_idx" ON "warehouse_stock_adjustments"("warehouseId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_transition_proposals_status_createdAt_idx" ON "warehouse_transition_proposals"("status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_restock_requests_requestNo_key" ON "warehouse_restock_requests"("requestNo");

-- CreateIndex
CREATE INDEX "warehouse_restock_requests_destWarehouseId_periodMonth_stat_idx" ON "warehouse_restock_requests"("destWarehouseId", "periodMonth", "status");

-- CreateIndex
CREATE INDEX "warehouse_restock_requests_status_createdAt_idx" ON "warehouse_restock_requests"("status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_transfers_trNo_key" ON "warehouse_transfers"("trNo");

-- CreateIndex
CREATE INDEX "warehouse_transfers_destWarehouseId_status_etaAt_idx" ON "warehouse_transfers"("destWarehouseId", "status", "etaAt");

-- CreateIndex
CREATE INDEX "warehouse_transfers_sourceWarehouseId_status_idx" ON "warehouse_transfers"("sourceWarehouseId", "status");

-- AddForeignKey
ALTER TABLE "warehouse_vendor_variants" ADD CONSTRAINT "warehouse_vendor_variants_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "warehouse_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_receipt_lines" ADD CONSTRAINT "warehouse_receipt_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "warehouse_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_restock_lines" ADD CONSTRAINT "warehouse_restock_lines_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "warehouse_restock_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_transfer_lines" ADD CONSTRAINT "warehouse_transfer_lines_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "warehouse_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Hand-written (D-57a): constraints Prisma cannot express, search / BRIN indexes, append-only
-- ledger, lifecycle seed. Future `migrate dev --create-only` runs must NOT drop these.
-- ---------------------------------------------------------------------------------------------

-- One position per (warehouse, batch, bin, owner, vendor); a missing bin / vendor counts as a value.
CREATE UNIQUE INDEX "warehouse_stock_positions_dims_key" ON "warehouse_stock_positions"
  ("warehouseId", "batchId", "binId", "ownerType", "vendorId") NULLS NOT DISTINCT;

ALTER TABLE "warehouse_stock_positions" ADD CONSTRAINT "warehouse_stock_positions_qty_check" CHECK (
  "qcHold" >= 0 AND "available" >= 0 AND "reserved" >= 0 AND "picked" >= 0 AND "packed" >= 0
  AND "quarantined" >= 0 AND "damaged" >= 0 AND "expired" >= 0 AND "returned" >= 0);
ALTER TABLE "warehouse_stock_summary" ADD CONSTRAINT "warehouse_stock_summary_qty_check" CHECK (
  "qcHold" >= 0 AND "available" >= 0 AND "reserved" >= 0 AND "picked" >= 0 AND "packed" >= 0
  AND "quarantined" >= 0 AND "damaged" >= 0 AND "expired" >= 0 AND "returned" >= 0
  AND "nearExpiry" >= 0 AND "expiryUnknown" >= 0);
ALTER TABLE "warehouse_stock_movements" ADD CONSTRAINT "warehouse_stock_movements_qty_check" CHECK ("qty" > 0);
ALTER TABLE "warehouse_receipt_lines" ADD CONSTRAINT "warehouse_receipt_lines_qty_check" CHECK ("qty" > 0);
ALTER TABLE "warehouse_transfer_lines" ADD CONSTRAINT "warehouse_transfer_lines_qty_check" CHECK ("qty" > 0 AND "receivedQty" >= 0 AND "receivedQty" <= "qty");
ALTER TABLE "warehouse_restock_lines" ADD CONSTRAINT "warehouse_restock_lines_qty_check" CHECK ("requestedQty" > 0);
ALTER TABLE "warehouse_stock_thresholds" ADD CONSTRAINT "warehouse_stock_thresholds_check" CHECK (
  "safetyStock" >= 0 AND "reorderLevel" >= 0 AND "targetStock" >= 0);
ALTER TABLE "warehouse_batches" ADD CONSTRAINT "warehouse_batches_dates_check" CHECK (
  "mfgDate" IS NULL OR "expiryDate" IS NULL OR "expiryDate" > "mfgDate");

-- One preferred vendor per SKU.
CREATE UNIQUE INDEX "warehouse_vendor_variants_preferred_key" ON "warehouse_vendor_variants" ("variantId") WHERE "isPreferred";

-- Search.
CREATE INDEX "warehouse_variant_projection_search_trgm_idx" ON "warehouse_variant_projection" USING GIN ("searchText" gin_trgm_ops);
CREATE INDEX "warehouse_vendors_name_trgm_idx" ON "warehouse_vendors" USING GIN (lower("name") gin_trgm_ops);
CREATE INDEX "warehouse_batches_batchno_trgm_idx" ON "warehouse_batches" USING GIN (lower("batchNo") gin_trgm_ops);

-- Large append-only ledger: BRIN on time.
CREATE INDEX "warehouse_stock_movements_created_brin" ON "warehouse_stock_movements" USING BRIN ("createdAt");

-- Append-only ledger (forbid_audit_mutation() comes from the auth migration).
CREATE TRIGGER "warehouse_stock_movements_append_only" BEFORE UPDATE OR DELETE ON "warehouse_stock_movements"
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER "warehouse_stock_movements_no_truncate" BEFORE TRUNCATE ON "warehouse_stock_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

-- Stock status lifecycle (W4.11): the 14 Figma rows + the reverse moves operations need.
INSERT INTO "warehouse_status_transitions"
  ("fromStatus", "toStatus", "requiredEvent", "roleLabel", "permissionKey", "systemOnly", "sortOrder", "updatedAt") VALUES
  ('RECEIVED',    'QC_HOLD',     'Receipt confirmed',                    'System',                      NULL,                         true,  10, now()),
  ('QC_HOLD',     'AVAILABLE',   'Quality released',                     'Authorized quality approver', 'quality.hold_release',       false, 20, now()),
  ('AVAILABLE',   'RESERVED',    'Eligible order allocation',            'OMS / WMS',                   'fulfilment.manage',          false, 30, now()),
  ('RESERVED',    'PICKED',      'Scan allocated stock',                 'Picker',                      'inventory.pick',             false, 40, now()),
  ('PICKED',      'PACKED',      'Packing verified',                     'Packing operator',            'fulfilment.manage',          false, 50, now()),
  ('PACKED',      'DISPATCHED',  'Dispatch scan / vehicle closed',       'Supervisor',                  'logistics.dispatch_assign',  false, 60, now()),
  ('DISPATCHED',  'DELIVERED',   'Proof of delivery recorded',           'Delivery team',               'logistics.delivery_confirm', false, 70, now()),
  ('AVAILABLE',   'QUARANTINED', 'Quality issue',                        'Quality team',                'quality.hold_create',        false, 80, now()),
  ('AVAILABLE',   'DAMAGED',     'Damage recorded',                      'Authorized role',             'inventory.adjust',           false, 90, now()),
  ('AVAILABLE',   'EXPIRED',     'Expiry reached',                       'System',                      NULL,                         true, 100, now()),
  ('AVAILABLE',   'IN_TRANSIT',  'Approved transfer scan-out',           'Supervisor',                  'inventory.transfer',         false, 110, now()),
  ('IN_TRANSIT',  'QC_HOLD',     'Destination receipt',                  'Receiving operator',          'inventory.receive',          false, 120, now()),
  ('DELIVERED',   'RETURNED',    'Approved return received',             'Returns team',                'inventory.receive',          false, 130, now()),
  ('RETURNED',    'QUARANTINED', 'Return inspection hold',               'Quality team',                'quality.hold_create',        false, 140, now()),
  ('RECEIVED',    'AVAILABLE',   'Receipt without QC (qcOnReceipt off)', 'System',                      NULL,                         true, 150, now()),
  ('AVAILABLE',   'QC_HOLD',     'Quality hold placed',                  'Quality team',                'quality.hold_create',        false, 160, now()),
  ('QC_HOLD',     'QUARANTINED', 'Quality failed',                       'Quality team',                'quality.hold_create',        false, 170, now()),
  ('RESERVED',    'AVAILABLE',   'Allocation released',                  'OMS / WMS',                   'fulfilment.manage',          false, 180, now()),
  ('PICKED',      'RETURNED',    'Cancelled after pick',                 'Supervisor',                  'fulfilment.manage',          false, 190, now()),
  ('PACKED',      'RETURNED',    'Cancelled after pack',                 'Supervisor',                  'fulfilment.manage',          false, 200, now()),
  ('RETURNED',    'AVAILABLE',   'Restock after inspection',             'Quality team',                'quality.hold_release',       false, 210, now()),
  ('QUARANTINED', 'AVAILABLE',   'Released after investigation',         'Authorized quality approver', 'quality.hold_release',       false, 220, now()),
  ('DAMAGED',     'WRITTEN_OFF', 'Approved write-off',                   'Authorized role',             'inventory.write_off',        false, 230, now()),
  ('EXPIRED',     'WRITTEN_OFF', 'Approved write-off',                   'Authorized role',             'inventory.write_off',        false, 240, now()),
  ('QUARANTINED', 'WRITTEN_OFF', 'Approved disposal',                    'Authorized role',             'inventory.write_off',        false, 250, now());
