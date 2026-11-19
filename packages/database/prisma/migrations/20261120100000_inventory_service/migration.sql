-- inventory-service (D-33): warehouses + PIN coverage, warehouse × variant stock, manual operations,
-- append-only ledger, reservations, availability publisher state, settings, audit.

-- CreateEnum
CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'CONFIRMED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StockOperationType" AS ENUM ('RECEIPT', 'DAMAGE', 'WRITE_OFF', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "StockOperationStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StockLedgerType" AS ENUM ('RECEIVE', 'ADJUST_IN', 'ADJUST_OUT', 'DAMAGE', 'WRITE_OFF', 'SALE');

-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('MOTHER', 'DEPOT');
-- CreateTable
CREATE TABLE "inventory_audit_log" (
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

    CONSTRAINT "inventory_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_variant_projections" (
    "variantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "name" VARCHAR(250) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "factsVersion" BIGINT NOT NULL DEFAULT -1,
    "factsAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_variant_projections_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" UUID NOT NULL,
    "orderRef" VARCHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "pinCode" CHAR(6) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paymentRef" VARCHAR(64),
    "confirmedAt" TIMESTAMP(3),
    "recoveredFromExpiry" BOOLEAN NOT NULL DEFAULT false,
    "expiredAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" VARCHAR(500),
    "releasedByUserId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservation_lines" (
    "reservationId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "inventory_reservation_lines_pkey" PRIMARY KEY ("reservationId","warehouseId","variantId")
);

-- CreateTable
CREATE TABLE "inventory_settings" (
    "key" VARCHAR(60) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "inventory_stock_levels" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "safetyStock" INTEGER NOT NULL DEFAULT 0,
    "reorderLevel" INTEGER NOT NULL DEFAULT 0,
    "lowStockAlerted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_operations" (
    "id" UUID NOT NULL,
    "type" "StockOperationType" NOT NULL,
    "status" "StockOperationStatus" NOT NULL,
    "warehouseId" UUID NOT NULL,
    "lines" JSONB NOT NULL,
    "reference" VARCHAR(80),
    "reason" VARCHAR(500),
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "requestedBy" UUID NOT NULL,
    "decidedBy" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stock_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_ledger" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "type" "StockLedgerType" NOT NULL,
    "onHandDelta" INTEGER NOT NULL,
    "damagedDelta" INTEGER NOT NULL DEFAULT 0,
    "onHandAfter" INTEGER NOT NULL,
    "damagedAfter" INTEGER NOT NULL,
    "refType" VARCHAR(20) NOT NULL,
    "refId" UUID NOT NULL,
    "actorUserId" UUID,
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stock_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_availability_dirty" (
    "variantId" UUID NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_availability_dirty_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "inventory_availability_state" (
    "variantId" UUID NOT NULL,
    "availableQty" INTEGER NOT NULL,
    "inStock" BOOLEAN NOT NULL,
    "lowStock" BOOLEAN NOT NULL,
    "sequence" BIGINT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_availability_state_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "inventory_warehouses" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "WarehouseType" NOT NULL,
    "addressLine" VARCHAR(250) NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "stateCode" CHAR(2) NOT NULL,
    "pinCode" CHAR(6) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isAllocatable" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "statusReason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_warehouse_coverage" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "pinCode" CHAR(6) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_warehouse_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_audit_log_targetType_targetId_createdAt_idx" ON "inventory_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_audit_log_actorUserId_createdAt_idx" ON "inventory_audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_variant_projections_productId_idx" ON "inventory_variant_projections"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_idempotencyKey_key" ON "inventory_reservations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "inventory_reservations_orderRef_idx" ON "inventory_reservations"("orderRef");

-- CreateIndex
CREATE INDEX "inventory_reservations_status_createdAt_idx" ON "inventory_reservations"("status", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_reservation_lines_warehouseId_variantId_idx" ON "inventory_reservation_lines"("warehouseId", "variantId");

-- CreateIndex
CREATE INDEX "inventory_stock_levels_variantId_idx" ON "inventory_stock_levels"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_levels_warehouseId_variantId_key" ON "inventory_stock_levels"("warehouseId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_operations_idempotencyKey_key" ON "inventory_stock_operations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "inventory_stock_operations_warehouseId_createdAt_idx" ON "inventory_stock_operations"("warehouseId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_stock_operations_type_status_createdAt_idx" ON "inventory_stock_operations"("type", "status", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_stock_ledger_warehouseId_variantId_createdAt_idx" ON "inventory_stock_ledger"("warehouseId", "variantId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_stock_ledger_variantId_createdAt_idx" ON "inventory_stock_ledger"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_stock_ledger_refType_refId_idx" ON "inventory_stock_ledger"("refType", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_warehouses_code_key" ON "inventory_warehouses"("code");

-- CreateIndex
CREATE INDEX "inventory_warehouses_isActive_isAllocatable_idx" ON "inventory_warehouses"("isActive", "isAllocatable");

-- CreateIndex
CREATE INDEX "inventory_warehouse_coverage_pinCode_priority_idx" ON "inventory_warehouse_coverage"("pinCode", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_warehouse_coverage_warehouseId_pinCode_key" ON "inventory_warehouse_coverage"("warehouseId", "pinCode");

-- AddForeignKey
ALTER TABLE "inventory_reservation_lines" ADD CONSTRAINT "inventory_reservation_lines_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "inventory_reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_warehouse_coverage" ADD CONSTRAINT "inventory_warehouse_coverage_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "inventory_warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Hand-written: invariants the database enforces whatever the code does.
-- ---------------------------------------------------------------------------------------------

-- Stock can never go negative and never be over-reserved (the final guard under concurrency).
ALTER TABLE "inventory_stock_levels"
  ADD CONSTRAINT "inventory_stock_levels_qty_chk" CHECK (
    "onHand" >= 0 AND "reserved" >= 0 AND "damaged" >= 0 AND "safetyStock" >= 0
    AND "reorderLevel" >= 0 AND "reserved" <= "onHand"
  );

ALTER TABLE "inventory_reservation_lines"
  ADD CONSTRAINT "inventory_reservation_lines_qty_chk" CHECK ("qty" > 0);

ALTER TABLE "inventory_warehouse_coverage"
  ADD CONSTRAINT "inventory_warehouse_coverage_pin_chk" CHECK ("pinCode" ~ '^[1-9][0-9]{5}$');

ALTER TABLE "inventory_warehouses"
  ADD CONSTRAINT "inventory_warehouses_code_chk" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  ADD CONSTRAINT "inventory_warehouses_pin_chk" CHECK ("pinCode" ~ '^[1-9][0-9]{5}$');

-- One live reservation per order reference.
CREATE UNIQUE INDEX "inventory_reservations_live_orderRef_key" ON "inventory_reservations"("orderRef")
  WHERE "status" IN ('ACTIVE', 'CONFIRMED');

-- Expiry sweep: only ACTIVE rows, oldest expiry first.
CREATE INDEX "inventory_reservations_active_expiresAt_idx" ON "inventory_reservations"("expiresAt")
  WHERE "status" = 'ACTIVE';

-- Ledger and audit log are append-only (function from the init migration).
CREATE TRIGGER "inventory_stock_ledger_append_only" BEFORE UPDATE OR DELETE ON "inventory_stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "inventory_stock_ledger_no_truncate" BEFORE TRUNCATE ON "inventory_stock_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "inventory_audit_log_append_only" BEFORE UPDATE OR DELETE ON "inventory_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "inventory_audit_log_no_truncate" BEFORE TRUNCATE ON "inventory_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- Default settings (editable through PATCH /admin/inventory/settings).
INSERT INTO "inventory_settings" ("key", "value") VALUES
  ('reservationTtlSeconds', '600'),
  ('defaultReorderLevel', '0'),
  ('maxReservationLines', '50'),
  ('allowSplitAllocation', 'true');
