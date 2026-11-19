-- catalog-service: brands (flat list, soft delete). Products will reference brands by a plain
-- indexed `brandId` uuid column (D-21) when the products feature is built.

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "description" VARCHAR(1000),
    "logoUrl" VARCHAR(500),
    "bannerUrl" VARCHAR(500),
    "websiteUrl" VARCHAR(500),
    "countryOfOrigin" CHAR(2),
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brands_isActive_isFeatured_sortOrder_idx" ON "brands"("isActive", "isFeatured", "sortOrder");

-- ── Raw SQL: uniqueness among live brands (a deleted brand frees its name, slug and code) ──

CREATE UNIQUE INDEX "brands_slug_live_key" ON "brands" ("slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "brands_code_live_key" ON "brands" ("code") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "brands_name_live_key" ON "brands" (lower("name")) WHERE "deletedAt" IS NULL;

ALTER TABLE "brands" ADD CONSTRAINT "brands_code_upper" CHECK ("code" = upper("code"));
ALTER TABLE "brands" ADD CONSTRAINT "brands_country_upper" CHECK ("countryOfOrigin" IS NULL OR "countryOfOrigin" = upper("countryOfOrigin"));
