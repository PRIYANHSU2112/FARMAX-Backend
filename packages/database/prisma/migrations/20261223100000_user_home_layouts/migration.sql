-- user-service feature: home (D-59). Server-driven Home / All Categories layouts.
-- CreateEnum
CREATE TYPE "HomePage" AS ENUM ('HOME', 'CATEGORIES');

-- CreateEnum
CREATE TYPE "HomeLayoutStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "HomeWidgetType" AS ENUM ('BANNER_CAROUSEL', 'CATEGORY_GRID', 'PRODUCT_GRID_2X2', 'PRODUCT_HORIZONTAL_RAIL', 'VET_CONSULT_PROMO', 'REORDER_CARD', 'FLOCK_STAGE_SELECTOR', 'NEWS_FEED', 'BULK_FEED_PROMO', 'LIVE_ORDER_STRIP', 'REQUIREMENT_CALENDAR', 'APPOINTMENT_CARD', 'SHOP_BY_PROBLEM', 'BRAND_GRID');

-- CreateEnum
CREATE TYPE "HomeDataSource" AS ENUM ('STATIC_ITEMS', 'MANUAL_PRODUCTS', 'DYNAMIC_QUERY', 'LIVE_OFFERS', 'BANNER_PLACEMENT', 'CATALOG_CATEGORIES', 'REMOTE_FEED');

-- CreateEnum
CREATE TYPE "HomeFeedKey" AS ENUM ('ORDER_LIVE', 'APPOINTMENT_NEXT', 'NEWS_LATEST', 'BUY_AGAIN', 'VET_AVAILABILITY', 'FLOCK_CONTEXT', 'REQUIREMENT_DUE');

-- CreateEnum
CREATE TYPE "HomeItemRefType" AS ENUM ('CATEGORY', 'FLOCK_STAGE', 'DISEASE', 'BRAND', 'PRODUCT', 'CUSTOM');

-- CreateTable
CREATE TABLE "home_configurations" (
    "id" UUID NOT NULL,
    "page" "HomePage" NOT NULL,
    "layoutNo" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "HomeLayoutStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" VARCHAR(1000),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "scheduledPublishAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" UUID,
    "publishRev" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "home_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_sections" (
    "id" UUID NOT NULL,
    "configurationId" UUID NOT NULL,
    "sectionKey" VARCHAR(60) NOT NULL,
    "widgetType" "HomeWidgetType" NOT NULL,
    "dataSource" "HomeDataSource" NOT NULL,
    "feedKey" "HomeFeedKey",
    "eyebrow" JSONB,
    "title" JSONB,
    "subtitle" JSONB,
    "viewAllLink" VARCHAR(500),
    "displayOrder" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "itemLimit" SMALLINT NOT NULL DEFAULT 10,
    "minItems" SMALLINT NOT NULL DEFAULT 1,
    "inline" BOOLEAN NOT NULL DEFAULT false,
    "experimentKey" VARCHAR(60),
    "config" JSONB NOT NULL DEFAULT '{}',
    "targeting" JSONB,

    CONSTRAINT "home_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_section_items" (
    "id" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "refType" "HomeItemRefType" NOT NULL,
    "refId" UUID,
    "refCode" VARCHAR(60),
    "label" JSONB NOT NULL,
    "subtitle" JSONB,
    "badge" JSONB,
    "image" JSONB,
    "deepLink" VARCHAR(500) NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "targeting" JSONB,
    "refBroken" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "home_section_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "home_configurations_page_status_id_idx" ON "home_configurations"("page", "status", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "home_configurations_page_layoutNo_key" ON "home_configurations"("page", "layoutNo");

-- CreateIndex
CREATE UNIQUE INDEX "home_configurations_page_publishRev_key" ON "home_configurations"("page", "publishRev");

-- CreateIndex
CREATE INDEX "home_sections_configurationId_displayOrder_idx" ON "home_sections"("configurationId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "home_sections_configurationId_sectionKey_key" ON "home_sections"("configurationId", "sectionKey");

-- CreateIndex
CREATE INDEX "home_section_items_sectionId_displayOrder_idx" ON "home_section_items"("sectionId", "displayOrder");

-- AddForeignKey
ALTER TABLE "home_sections" ADD CONSTRAINT "home_sections_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "home_configurations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_section_items" ADD CONSTRAINT "home_section_items_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "home_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One live (PUBLISHED) layout per page.
CREATE UNIQUE INDEX "home_configurations_one_published" ON "home_configurations" ("page")
  WHERE "status" = 'PUBLISHED';

-- One SCHEDULED layout per page (scheduling a new one sends the old one back to DRAFT).
CREATE UNIQUE INDEX "home_configurations_one_scheduled" ON "home_configurations" ("page")
  WHERE "status" = 'SCHEDULED';

-- A scheduled layout always has its go-live time; a live or archived one has its revision.
ALTER TABLE "home_configurations" ADD CONSTRAINT "home_configurations_scheduled_at_check"
  CHECK ("status" <> 'SCHEDULED' OR "scheduledPublishAt" IS NOT NULL);
ALTER TABLE "home_configurations" ADD CONSTRAINT "home_configurations_publish_rev_check"
  CHECK ("status" NOT IN ('PUBLISHED', 'ARCHIVED') OR "publishRev" IS NOT NULL);
