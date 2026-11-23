-- D-56 P3: warehouse stock / order read models (warehouse-service) + variant root category and
-- pack weight in the inventory projection (warehouse stock-by-category and capacity in kg).

-- CreateEnum
CREATE TYPE "WmsFulfilmentStatus" AS ENUM ('NEW', 'ALLOCATED', 'DELIVERED', 'CANCELLED');

-- AlterTable
ALTER TABLE "inventory_variant_projections" ADD COLUMN     "rootCategoryId" UUID,
ADD COLUMN     "weightGrams" INTEGER;

-- CreateTable
CREATE TABLE "warehouse_order_headers" (
    "orderId" UUID NOT NULL,
    "orderNo" VARCHAR(30) NOT NULL,
    "shipToName" VARCHAR(120),
    "district" VARCHAR(80),
    "pinCode" CHAR(6),
    "placedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_order_headers_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "warehouse_order_allocations" (
    "orderId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" "WmsFulfilmentStatus" NOT NULL DEFAULT 'NEW',
    "lines" JSONB NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "unitCount" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_order_allocations_pkey" PRIMARY KEY ("orderId","warehouseId")
);

-- CreateTable
CREATE TABLE "warehouse_stock_current" (
    "warehouseId" UUID NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "skuCount" INTEGER NOT NULL DEFAULT 0,
    "usedKg" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "weighedUnits" INTEGER NOT NULL DEFAULT 0,
    "unweighedUnits" INTEGER NOT NULL DEFAULT 0,
    "unweighedSkus" INTEGER NOT NULL DEFAULT 0,
    "weightKnownPct" DECIMAL(5,1) NOT NULL DEFAULT 100,
    "asOf" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stock_current_pkey" PRIMARY KEY ("warehouseId")
);

-- CreateTable
CREATE TABLE "warehouse_stock_by_category" (
    "warehouseId" UUID NOT NULL,
    "rootCategoryId" UUID NOT NULL,
    "skuCount" INTEGER NOT NULL DEFAULT 0,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_stock_by_category_pkey" PRIMARY KEY ("warehouseId","rootCategoryId")
);

-- CreateTable
CREATE TABLE "warehouse_daily_stats" (
    "warehouseId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "openOrders" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_daily_stats_pkey" PRIMARY KEY ("warehouseId","day")
);

-- CreateIndex
CREATE INDEX "warehouse_order_headers_orderNo_idx" ON "warehouse_order_headers"("orderNo");

-- CreateIndex
CREATE INDEX "warehouse_order_allocations_warehouseId_status_orderId_idx" ON "warehouse_order_allocations"("warehouseId", "status", "orderId" DESC);

-- Backfill the projection from product-service + catalog (same database; one-off, new facts
-- arrive through product events). Root category = first id of the materialised path.
UPDATE "inventory_variant_projections" p
SET "weightGrams" = v."weightGrams",
    "rootCategoryId" = COALESCE(NULLIF(split_part(c."path", '/', 2), '')::uuid, pr."categoryId")
FROM "product_variants" v
JOIN "products" pr ON pr."id" = v."productId"
LEFT JOIN "categories" c ON c."id" = pr."categoryId"
WHERE v."id" = p."variantId";
