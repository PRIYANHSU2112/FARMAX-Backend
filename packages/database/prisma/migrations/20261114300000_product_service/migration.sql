-- product-service: products, variants, ingredients, media, master lookups, category attributes,
-- compliance profiles, price/availability projections, reference blocks and audit (plan §C).

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "AttributeDataType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'DATE');

-- CreateEnum
CREATE TYPE "ProductLookupGroup" AS ENUM ('DOSAGE_FORM', 'ROUTE', 'SPECIES', 'UNIT');

-- CreateEnum
CREATE TYPE "DrugSchedule" AS ENUM ('OTC', 'G', 'H', 'H1', 'X');

-- CreateEnum
CREATE TYPE "RegistrationAuthority" AS ENUM ('CDSCO', 'STATE');

-- CreateEnum
CREATE TYPE "TemperatureClass" AS ENUM ('AMB', 'AMB_CTL', 'CC_REF', 'CC_FRZ', 'HAZ');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'SUSPENDED', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "ProductMediaKind" AS ENUM ('IMAGE', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "ProductDocType" AS ENUM ('TDS', 'SDS', 'MSDS', 'LEAFLET', 'PACKAGE_INSERT', 'LABEL', 'CERTIFICATE');

-- CreateEnum
CREATE TYPE "ProductReferenceType" AS ENUM ('CATEGORY', 'BRAND');

-- CreateTable
CREATE TABLE "category_attributes" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "dataType" "AttributeDataType" NOT NULL,
    "unit" VARCHAR(20),
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isFilterable" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "category_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_compliance_profiles" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "requiresRegistration" BOOLEAN NOT NULL DEFAULT false,
    "requiresDrugLicense" BOOLEAN NOT NULL DEFAULT false,
    "requiresManufacturingLicense" BOOLEAN NOT NULL DEFAULT false,
    "requiresWithdrawal" BOOLEAN NOT NULL DEFAULT false,
    "requiresColdChain" BOOLEAN NOT NULL DEFAULT false,
    "requiredDocTypes" "ProductDocType"[] DEFAULT ARRAY[]::"ProductDocType"[],
    "allowedSchedules" "DrugSchedule"[] DEFAULT ARRAY[]::"DrugSchedule"[],
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_compliance_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_audit_log" (
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

    CONSTRAINT "product_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_lookups" (
    "id" UUID NOT NULL,
    "group" "ProductLookupGroup" NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300),
    "meta" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_lookups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(180) NOT NULL,
    "productCode" VARCHAR(20) NOT NULL,
    "shortDescription" VARCHAR(300),
    "description" TEXT,
    "categoryId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "brandName" VARCHAR(80) NOT NULL,
    "genericName" VARCHAR(200),
    "dosageFormId" UUID,
    "productionStages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "indications" TEXT,
    "dosageInstructions" TEXT,
    "contraindications" TEXT,
    "sideEffects" TEXT,
    "precautions" TEXT,
    "withdrawalMeatDays" SMALLINT,
    "withdrawalEggDays" SMALLINT,
    "manufacturerName" VARCHAR(160),
    "manufacturerAddress" VARCHAR(500),
    "marketerName" VARCHAR(160),
    "drugSchedule" "DrugSchedule" NOT NULL DEFAULT 'OTC',
    "registrationAuthority" "RegistrationAuthority",
    "registrationNo" VARCHAR(60),
    "drugLicenseNo" VARCHAR(60),
    "manufacturingLicenseNo" VARCHAR(60),
    "isPrescriptionRequired" BOOLEAN NOT NULL DEFAULT false,
    "isVetConsultRequired" BOOLEAN NOT NULL DEFAULT false,
    "isAntimicrobial" BOOLEAN NOT NULL DEFAULT false,
    "temperatureClass" "TemperatureClass" NOT NULL DEFAULT 'AMB',
    "storageMinTempC" DECIMAL(4,1),
    "storageMaxTempC" DECIMAL(4,1),
    "isFreezeSensitive" BOOLEAN NOT NULL DEFAULT false,
    "isLightSensitive" BOOLEAN NOT NULL DEFAULT false,
    "isHumiditySensitive" BOOLEAN NOT NULL DEFAULT false,
    "storageInstructions" VARCHAR(500),
    "shelfLifeMonths" SMALLINT,
    "hazardClass" VARCHAR(40),
    "unNumber" VARCHAR(10),
    "hsnCode" VARCHAR(8) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL,
    "countryOfOrigin" CHAR(2),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seoTitle" VARCHAR(70),
    "seoDescription" VARCHAR(160),
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedByUserId" UUID,
    "submittedAt" TIMESTAMP(3),
    "publishedByUserId" UUID,
    "publishedAt" TIMESTAMP(3),
    "searchText" TEXT NOT NULL DEFAULT '',
    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "searchText")) STORED,
    "minPrice" DECIMAL(14,2),
    "maxPrice" DECIMAL(14,2),
    "maxDiscountPercent" DECIMAL(5,2),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_routes" (
    "productId" UUID NOT NULL,
    "lookupId" UUID NOT NULL,

    CONSTRAINT "product_routes_pkey" PRIMARY KEY ("productId","lookupId")
);

-- CreateTable
CREATE TABLE "product_species" (
    "productId" UUID NOT NULL,
    "lookupId" UUID NOT NULL,

    CONSTRAINT "product_species_pkey" PRIMARY KEY ("productId","lookupId")
);

-- CreateTable
CREATE TABLE "product_ingredients" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "strength" DECIMAL(14,4) NOT NULL,
    "unitId" UUID NOT NULL,
    "perQuantity" DECIMAL(14,4),
    "perUnitId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "barcode" VARCHAR(20),
    "name" VARCHAR(80) NOT NULL,
    "packSize" DECIMAL(12,3) NOT NULL,
    "packUnitId" UUID NOT NULL,
    "unitsPerPack" INTEGER NOT NULL DEFAULT 1,
    "mrp" DECIMAL(14,2) NOT NULL,
    "minOrderQty" INTEGER NOT NULL DEFAULT 1,
    "maxOrderQty" INTEGER,
    "isB2cEligible" BOOLEAN NOT NULL DEFAULT false,
    "weightGrams" INTEGER,
    "lengthMm" INTEGER,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "hsnCode" VARCHAR(8),
    "gstRate" DECIMAL(5,2),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_media" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "kind" "ProductMediaKind" NOT NULL,
    "docType" "ProductDocType",
    "url" VARCHAR(500) NOT NULL,
    "mediaId" UUID,
    "title" VARCHAR(120),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_price_projections" (
    "variantId" UUID NOT NULL,
    "sellingPrice" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "sourceEventId" UUID NOT NULL,
    "sourceVersion" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_price_projections_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "variant_availability" (
    "variantId" UUID NOT NULL,
    "availableQty" INTEGER NOT NULL,
    "inStock" BOOLEAN NOT NULL,
    "lowStock" BOOLEAN NOT NULL,
    "sourceVersion" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_availability_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "product_reference_blocks" (
    "id" UUID NOT NULL,
    "refType" "ProductReferenceType" NOT NULL,
    "refId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_reference_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "category_attributes_categoryId_sortOrder_idx" ON "category_attributes"("categoryId", "sortOrder");

-- CreateIndex
CREATE INDEX "product_audit_log_targetType_targetId_createdAt_idx" ON "product_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "product_audit_log_actorUserId_createdAt_idx" ON "product_audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "product_lookups_group_isActive_sortOrder_idx" ON "product_lookups"("group", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "products_categoryId_idx" ON "products"("categoryId");

-- CreateIndex
CREATE INDEX "products_brandId_idx" ON "products"("brandId");

-- CreateIndex
CREATE INDEX "products_status_isActive_isFeatured_idx" ON "products"("status", "isActive", "isFeatured");

-- CreateIndex
CREATE INDEX "product_routes_lookupId_idx" ON "product_routes"("lookupId");

-- CreateIndex
CREATE INDEX "product_species_lookupId_idx" ON "product_species"("lookupId");

-- CreateIndex
CREATE INDEX "product_ingredients_productId_sortOrder_idx" ON "product_ingredients"("productId", "sortOrder");

-- CreateIndex
CREATE INDEX "product_variants_productId_sortOrder_idx" ON "product_variants"("productId", "sortOrder");

-- CreateIndex
CREATE INDEX "product_media_productId_kind_sortOrder_idx" ON "product_media"("productId", "kind", "sortOrder");

-- CreateIndex
CREATE INDEX "variant_availability_inStock_idx" ON "variant_availability"("inStock");

-- CreateIndex
CREATE UNIQUE INDEX "product_reference_blocks_refType_refId_key" ON "product_reference_blocks"("refType", "refId");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_dosageFormId_fkey" FOREIGN KEY ("dosageFormId") REFERENCES "product_lookups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_routes" ADD CONSTRAINT "product_routes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_routes" ADD CONSTRAINT "product_routes_lookupId_fkey" FOREIGN KEY ("lookupId") REFERENCES "product_lookups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_species" ADD CONSTRAINT "product_species_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_species" ADD CONSTRAINT "product_species_lookupId_fkey" FOREIGN KEY ("lookupId") REFERENCES "product_lookups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "product_lookups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_perUnitId_fkey" FOREIGN KEY ("perUnitId") REFERENCES "product_lookups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_packUnitId_fkey" FOREIGN KEY ("packUnitId") REFERENCES "product_lookups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_price_projections" ADD CONSTRAINT "variant_price_projections_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_availability" ADD CONSTRAINT "variant_availability_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Raw SQL: live-row uniqueness, integrity checks, search, sequences, audit, seed lookups ──

-- Uniqueness among live rows (a soft-deleted row frees its key).
CREATE UNIQUE INDEX "product_lookups_group_code_live_key" ON "product_lookups" ("group", "code") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "products_slug_live_key" ON "products" ("slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "products_code_live_key" ON "products" ("productCode") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "product_variants_sku_live_key" ON "product_variants" ("sku") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "product_variants_barcode_live_key" ON "product_variants" ("barcode") WHERE "deletedAt" IS NULL AND "barcode" IS NOT NULL;
-- At most one live default variant per product (the service guarantees at least one).
CREATE UNIQUE INDEX "product_variants_one_default_key" ON "product_variants" ("productId") WHERE "isDefault" AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "category_attributes_key_live_key" ON "category_attributes" ("categoryId", "key") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "product_compliance_profiles_category_live_key" ON "product_compliance_profiles" ("categoryId") WHERE "deletedAt" IS NULL;

-- Integrity.
ALTER TABLE "product_lookups" ADD CONSTRAINT "product_lookups_code_upper" CHECK ("code" = upper("code"));
ALTER TABLE "products" ADD CONSTRAINT "products_withdrawal_non_negative" CHECK (("withdrawalMeatDays" IS NULL OR "withdrawalMeatDays" >= 0) AND ("withdrawalEggDays" IS NULL OR "withdrawalEggDays" >= 0));
ALTER TABLE "products" ADD CONSTRAINT "products_storage_range" CHECK ("storageMinTempC" IS NULL OR "storageMaxTempC" IS NULL OR "storageMinTempC" <= "storageMaxTempC");
ALTER TABLE "products" ADD CONSTRAINT "products_gst_rate" CHECK ("gstRate" >= 0 AND "gstRate" <= 28);
ALTER TABLE "products" ADD CONSTRAINT "products_hsn_digits" CHECK ("hsnCode" ~ '^[0-9]{4,8}$');
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_positive" CHECK ("packSize" > 0 AND "unitsPerPack" >= 1 AND "mrp" > 0 AND "minOrderQty" >= 1 AND ("maxOrderQty" IS NULL OR "maxOrderQty" >= "minOrderQty"));
ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_strength_positive" CHECK ("strength" > 0);
ALTER TABLE "variant_availability" ADD CONSTRAINT "variant_availability_non_negative" CHECK ("availableQty" >= 0);

-- Storefront search: full text + trigram (typos) over the service-maintained searchText.
CREATE INDEX "products_search_vector_idx" ON "products" USING GIN ("searchVector");
CREATE INDEX "products_search_trgm_idx" ON "products" USING GIN ("searchText" gin_trgm_ops);
CREATE INDEX "products_tags_idx" ON "products" USING GIN ("tags");
CREATE INDEX "products_storefront_idx" ON "products" ("categoryId", "minPrice") WHERE "status" = 'PUBLISHED' AND "isActive" AND "deletedAt" IS NULL;
CREATE INDEX "product_ingredients_name_idx" ON "product_ingredients" (lower("name"));

-- Human product codes FXP-000001 …
CREATE SEQUENCE "product_code_seq" START 1;

-- Append-only audit (D-15 function from the init migration).
CREATE TRIGGER "product_audit_log_append_only" BEFORE UPDATE OR DELETE ON "product_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "product_audit_log_no_truncate" BEFORE TRUNCATE ON "product_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- Seed master lookups (admins add more; codes are stable keys).
INSERT INTO "product_lookups" ("id", "group", "code", "label", "meta", "sortOrder", "createdByUserId", "updatedByUserId", "updatedAt")
SELECT gen_random_uuid(), v."group"::"ProductLookupGroup", v."code", v."label", v."meta"::jsonb, v."sortOrder",
       '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, CURRENT_TIMESTAMP
FROM (VALUES
  ('DOSAGE_FORM', 'INJECTION', 'Injection', '{}', 10),
  ('DOSAGE_FORM', 'ORAL_SOLUTION', 'Oral solution', '{}', 20),
  ('DOSAGE_FORM', 'ORAL_POWDER', 'Oral / water-soluble powder', '{}', 30),
  ('DOSAGE_FORM', 'TABLET', 'Tablet', '{}', 40),
  ('DOSAGE_FORM', 'BOLUS', 'Bolus', '{}', 50),
  ('DOSAGE_FORM', 'FEED_PREMIX', 'Feed premix', '{}', 60),
  ('DOSAGE_FORM', 'LYOPHILISED_VACCINE', 'Freeze-dried vaccine', '{}', 70),
  ('DOSAGE_FORM', 'EMULSION_VACCINE', 'Oil-emulsion vaccine', '{}', 80),
  ('DOSAGE_FORM', 'SPRAY', 'Spray', '{}', 90),
  ('DOSAGE_FORM', 'DROPS', 'Drops', '{}', 100),
  ('DOSAGE_FORM', 'LIQUID_CONCENTRATE', 'Liquid concentrate (disinfectant)', '{}', 110),
  ('ROUTE', 'IM', 'Intramuscular', '{}', 10),
  ('ROUTE', 'SC', 'Subcutaneous', '{}', 20),
  ('ROUTE', 'ORAL', 'Oral', '{}', 30),
  ('ROUTE', 'DRINKING_WATER', 'Drinking water', '{}', 40),
  ('ROUTE', 'IN_FEED', 'In feed', '{}', 50),
  ('ROUTE', 'EYE_DROP', 'Eye drop / intra-ocular', '{}', 60),
  ('ROUTE', 'NASAL', 'Intranasal', '{}', 70),
  ('ROUTE', 'WING_WEB', 'Wing web', '{}', 80),
  ('ROUTE', 'SPRAY', 'Coarse spray', '{}', 90),
  ('ROUTE', 'IN_OVO', 'In ovo', '{}', 100),
  ('ROUTE', 'TOPICAL', 'Topical / environmental', '{}', 110),
  ('SPECIES', 'BROILER', 'Broiler', '{"producesMeat": true, "producesEggs": false}', 10),
  ('SPECIES', 'LAYER', 'Layer', '{"producesMeat": true, "producesEggs": true}', 20),
  ('SPECIES', 'BREEDER', 'Breeder', '{"producesMeat": true, "producesEggs": true}', 30),
  ('SPECIES', 'CHICK', 'Chick', '{"producesMeat": true, "producesEggs": false}', 40),
  ('SPECIES', 'GROWER', 'Grower / pullet', '{"producesMeat": true, "producesEggs": false}', 50),
  ('SPECIES', 'DUCK', 'Duck', '{"producesMeat": true, "producesEggs": true}', 60),
  ('SPECIES', 'QUAIL', 'Quail', '{"producesMeat": true, "producesEggs": true}', 70),
  ('UNIT', 'ML', 'ml', '{}', 10),
  ('UNIT', 'L', 'L', '{}', 20),
  ('UNIT', 'MG', 'mg', '{}', 30),
  ('UNIT', 'G', 'g', '{}', 40),
  ('UNIT', 'KG', 'kg', '{}', 50),
  ('UNIT', 'MCG', 'mcg', '{}', 60),
  ('UNIT', 'IU', 'IU', '{}', 70),
  ('UNIT', 'PERCENT', '%', '{}', 80),
  ('UNIT', 'EID50', 'EID50', '{}', 90),
  ('UNIT', 'CFU', 'CFU', '{}', 100),
  ('UNIT', 'DOSE', 'dose', '{}', 110),
  ('UNIT', 'TABLET', 'tablet', '{}', 120),
  ('UNIT', 'VIAL', 'vial', '{}', 130),
  ('UNIT', 'SACHET', 'sachet', '{}', 140),
  ('UNIT', 'PIECE', 'piece', '{}', 150)
) AS v("group", "code", "label", "meta", "sortOrder");
