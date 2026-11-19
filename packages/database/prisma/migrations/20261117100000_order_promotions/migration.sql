-- order-service: promotions (offers, coupons, auto bonuses, shipping promos), redemption tables
-- (written by checkout in Step 2), read-only projections of variants / prices / farms, and
-- order_audit_log (append-only, D-22). farmId / variantId / categoryId … are plain uuid
-- references to other services (D-21).

-- CreateEnum
CREATE TYPE "PromoKind" AS ENUM ('LINE_OFFER', 'ORDER_COUPON', 'AUTO_BONUS', 'SHIPPING');

-- CreateEnum
CREATE TYPE "BenefitType" AS ENUM ('FLAT', 'PERCENTAGE', 'COMBO', 'BUNDLE_PAIR', 'FREE_SHIPPING');

-- CreateEnum
CREATE TYPE "PromoScope" AS ENUM ('PLATFORM_WIDE', 'CATEGORY', 'PRODUCT', 'VARIANT', 'BRAND');

-- CreateEnum
CREATE TYPE "PromoStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PromoAccountType" AS ENUM ('ALL', 'B2B_GST', 'RETAIL');

-- CreateEnum
CREATE TYPE "PromoFarmHistory" AS ENUM ('ALL', 'NEW_FARM', 'EXISTING_FARM');

-- CreateEnum
CREATE TYPE "PromoPaymentMethod" AS ENUM ('ANY', 'UPI', 'CARD', 'NETBANKING');

-- CreateEnum
CREATE TYPE "PromoTargetType" AS ENUM ('CATEGORY', 'PRODUCT', 'VARIANT', 'BRAND');

-- CreateEnum
CREATE TYPE "PromoRuleType" AS ENUM ('PRODUCTION_TYPE', 'FARM_CATEGORY', 'STATE', 'TERRITORY', 'PINCODE', 'BANK', 'CARD_BIN');


-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('APPLIED', 'PARTIALLY_REVERSED', 'REVERSED');

-- CreateTable
CREATE TABLE "order_audit_log" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "action" VARCHAR(60) NOT NULL,
    "targetType" VARCHAR(30) NOT NULL,
    "targetId" VARCHAR(64) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(500),
    "ip" VARCHAR(45),
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_variant_projections" (
    "variantId" UUID NOT NULL,
    "productId" UUID,
    "sku" VARCHAR(40),
    "name" VARCHAR(250),
    "categoryId" UUID,
    "categoryPath" UUID[] DEFAULT ARRAY[]::UUID[],
    "brandId" UUID,
    "hsnCode" VARCHAR(8),
    "gstRate" DECIMAL(5,2),
    "temperatureClass" VARCHAR(10) NOT NULL DEFAULT 'AMB',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "factsVersion" BIGINT NOT NULL DEFAULT -1,
    "factsAt" TIMESTAMP(3),
    "sellingPrice" DECIMAL(14,2),
    "priceVersion" BIGINT NOT NULL DEFAULT -1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_variant_projections_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "order_farm_projections" (
    "farmId" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "farmCode" VARCHAR(20),
    "name" VARCHAR(120) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "productionTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gstin" CHAR(15),
    "stateCode" CHAR(2),
    "territoryCode" VARCHAR(3),
    "pinCode" CHAR(6),
    "status" VARCHAR(20) NOT NULL,
    "sourceVersion" BIGINT NOT NULL,
    "sourceAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_farm_projections_pkey" PRIMARY KEY ("farmId")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30),
    "title" VARCHAR(120) NOT NULL,
    "subtitle" VARCHAR(160),
    "termsText" TEXT,
    "badgeText" VARCHAR(30),
    "kind" "PromoKind" NOT NULL,
    "benefitType" "BenefitType" NOT NULL,
    "flatAmount" DECIMAL(14,2),
    "percentage" DECIMAL(5,2),
    "maxDiscountAmount" DECIMAL(14,2),
    "comboBuyQty" INTEGER,
    "comboGetQty" INTEGER,
    "comboGetPercent" DECIMAL(5,2),
    "bundlePrice" DECIMAL(14,2),
    "freeShipping" BOOLEAN NOT NULL DEFAULT false,
    "scope" "PromoScope" NOT NULL DEFAULT 'PLATFORM_WIDE',
    "minOrderAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "PromoStatus" NOT NULL DEFAULT 'DRAFT',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusChangedByUserId" UUID NOT NULL,
    "statusReason" VARCHAR(500),
    "isAutoApply" BOOLEAN NOT NULL DEFAULT false,
    "isStackable" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "totalUsageLimit" INTEGER,
    "perFarmLimit" INTEGER,
    "perUserLimit" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "accountType" "PromoAccountType" NOT NULL DEFAULT 'ALL',
    "farmHistory" "PromoFarmHistory" NOT NULL DEFAULT 'ALL',
    "paymentMethod" "PromoPaymentMethod" NOT NULL DEFAULT 'ANY',
    "isMemberOnly" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_targets" (
    "id" UUID NOT NULL,
    "promotionId" UUID NOT NULL,
    "targetType" "PromoTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "bundleQty" INTEGER,

    CONSTRAINT "promotion_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_rule_values" (
    "id" UUID NOT NULL,
    "promotionId" UUID NOT NULL,
    "ruleType" "PromoRuleType" NOT NULL,
    "value" VARCHAR(40) NOT NULL,

    CONSTRAINT "promotion_rule_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_redemptions" (
    "id" UUID NOT NULL,
    "promotionId" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "discountAmount" DECIMAL(14,2) NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'APPLIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promo_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_redemption_items" (
    "id" UUID NOT NULL,
    "redemptionId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "discountAmount" DECIMAL(14,2) NOT NULL,
    "reversedQty" INTEGER NOT NULL DEFAULT 0,
    "reversedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'APPLIED',

    CONSTRAINT "promo_redemption_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_audit_log_targetType_targetId_createdAt_idx" ON "order_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "order_audit_log_actorUserId_createdAt_idx" ON "order_audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "order_variant_projections_productId_idx" ON "order_variant_projections"("productId");

-- CreateIndex
CREATE INDEX "order_farm_projections_ownerUserId_idx" ON "order_farm_projections"("ownerUserId");

-- CreateIndex
CREATE INDEX "promotions_status_startAt_endAt_idx" ON "promotions"("status", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "promotions_kind_status_idx" ON "promotions"("kind", "status");

-- CreateIndex
CREATE INDEX "promotion_targets_targetType_targetId_idx" ON "promotion_targets"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_targets_promotionId_targetType_targetId_key" ON "promotion_targets"("promotionId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_rule_values_promotionId_ruleType_value_key" ON "promotion_rule_values"("promotionId", "ruleType", "value");

-- CreateIndex
CREATE INDEX "promo_redemptions_promotionId_farmId_status_idx" ON "promo_redemptions"("promotionId", "farmId", "status");

-- CreateIndex
CREATE INDEX "promo_redemptions_promotionId_userId_status_idx" ON "promo_redemptions"("promotionId", "userId", "status");

-- CreateIndex
CREATE INDEX "promo_redemptions_orderId_idx" ON "promo_redemptions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemptions_promotionId_orderId_key" ON "promo_redemptions"("promotionId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemption_items_redemptionId_orderItemId_key" ON "promo_redemption_items"("redemptionId", "orderItemId");

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_rule_values" ADD CONSTRAINT "promotion_rule_values_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_redemption_items" ADD CONSTRAINT "promo_redemption_items_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "promo_redemptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Hand-written (not expressible in Prisma) ──

-- [R1] One live promotion per code; codes are stored UPPERCASE (case-insensitive by construction).
CREATE UNIQUE INDEX "promotions_code_live_key" ON "promotions" ("code") WHERE "deletedAt" IS NULL AND "code" IS NOT NULL;
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_code_upper_chk" CHECK ("code" IS NULL OR "code" = UPPER(BTRIM("code")));
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_window_chk" CHECK ("endAt" > "startAt");
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_used_count_chk" CHECK ("usedCount" >= 0 AND ("totalUsageLimit" IS NULL OR "usedCount" <= "totalUsageLimit"));
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_percentage_chk" CHECK ("percentage" IS NULL OR ("percentage" > 0 AND "percentage" <= 100));
ALTER TABLE "promo_redemption_items" ADD CONSTRAINT "promo_redemption_items_reversal_chk" CHECK ("reversedQty" >= 0 AND "reversedQty" <= "quantity" AND "reversedAmount" >= 0 AND "reversedAmount" <= "discountAmount");

-- Active offers lookup (offers / preview): live, ACTIVE rows only.
CREATE INDEX "promotions_live_active_idx" ON "promotions" ("kind", "endAt") WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL;

-- Audit log is append-only (function from the init migration).
CREATE TRIGGER "order_audit_log_append_only" BEFORE UPDATE OR DELETE ON "order_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "order_audit_log_no_truncate" BEFORE TRUNCATE ON "order_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
