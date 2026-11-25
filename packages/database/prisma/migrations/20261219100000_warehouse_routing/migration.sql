-- CreateEnum
CREATE TYPE "WmsRoutingRankBy" AS ENUM ('NEAREST', 'PRIORITY', 'MOST_STOCK', 'LOWEST_COST');

-- CreateEnum
CREATE TYPE "WmsBackorderStatus" AS ENUM ('OPEN', 'ALLOCATED', 'CANCELLED');

-- CreateTable
CREATE TABLE "warehouse_routing_rules" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "tag" VARCHAR(30),
    "priority" INTEGER NOT NULL,
    "conditions" JSONB NOT NULL,
    "primaryWarehouseId" UUID,
    "primaryDockDoorId" UUID,
    "fallbackWarehouseIds" TEXT[],
    "rankBy" "WmsRoutingRankBy" NOT NULL DEFAULT 'NEAREST',
    "gates" JSONB NOT NULL DEFAULT '{}',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_routing_rule_versions" (
    "id" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "by" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_routing_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_routing_throttles" (
    "warehouseId" UUID NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "maxOrdersPerDay" INTEGER,
    "note" VARCHAR(300),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_routing_throttles_pkey" PRIMARY KEY ("warehouseId")
);

-- CreateTable
CREATE TABLE "warehouse_backorders" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "shipmentId" UUID,
    "orderLineNo" INTEGER,
    "variantId" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "promiseDate" DATE,
    "status" "WmsBackorderStatus" NOT NULL DEFAULT 'OPEN',
    "warehouseId" UUID,
    "consentLogged" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(300),
    "createdBy" UUID,
    "allocatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_backorders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_storefront_sync" (
    "variantId" UUID NOT NULL,
    "publishedQty" INTEGER NOT NULL,
    "inStock" BOOLEAN NOT NULL,
    "sequence" BIGINT NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_storefront_sync_pkey" PRIMARY KEY ("variantId")
);

-- CreateIndex
CREATE INDEX "warehouse_routing_rules_deletedAt_priority_idx" ON "warehouse_routing_rules"("deletedAt", "priority");

-- CreateIndex
CREATE INDEX "warehouse_routing_rule_versions_ruleId_at_idx" ON "warehouse_routing_rule_versions"("ruleId", "at");

-- CreateIndex
CREATE INDEX "warehouse_routing_rule_versions_at_idx" ON "warehouse_routing_rule_versions"("at");

-- CreateIndex
CREATE INDEX "warehouse_backorders_status_promiseDate_idx" ON "warehouse_backorders"("status", "promiseDate");

-- CreateIndex
CREATE INDEX "warehouse_backorders_orderId_idx" ON "warehouse_backorders"("orderId");

-- CreateIndex
CREATE INDEX "warehouse_backorders_variantId_status_idx" ON "warehouse_backorders"("variantId", "status");

-- CreateIndex
CREATE INDEX "warehouse_storefront_sync_publishedAt_idx" ON "warehouse_storefront_sync"("publishedAt");

-- ── Hand-written (D-57b Phase 5) ──
-- One live rule per priority (drafts and deleted rules excluded); history is append-only.
CREATE UNIQUE INDEX "warehouse_routing_rules_live_priority_key" ON "warehouse_routing_rules" ("priority")
  WHERE "deletedAt" IS NULL AND NOT "isDraft";
CREATE TRIGGER "warehouse_routing_rule_versions_no_update" BEFORE UPDATE OR DELETE ON "warehouse_routing_rule_versions"
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
ALTER TABLE "warehouse_backorders" ADD CONSTRAINT "warehouse_backorders_qty_check" CHECK ("qty" > 0);
