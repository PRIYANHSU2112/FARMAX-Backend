-- catalog-service: banner placements (dynamic slots) + banners (scheduled, soft delete).

-- CreateTable
CREATE TABLE "banner_placements" (
    "id" UUID NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "app" VARCHAR(30) NOT NULL,
    "page" VARCHAR(40) NOT NULL,
    "position" VARCHAR(40) NOT NULL,
    "aspectRatio" VARCHAR(10) NOT NULL,
    "maxItems" INTEGER NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "banner_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banners" (
    "id" UUID NOT NULL,
    "placementId" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "subtitle" VARCHAR(250),
    "imageUrl" VARCHAR(500) NOT NULL,
    "mobileImageUrl" VARCHAR(500),
    "actionType" VARCHAR(20) NOT NULL DEFAULT 'NONE',
    "actionTarget" VARCHAR(500),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "banners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "banner_placements_app_page_position_idx" ON "banner_placements"("app", "page", "position");

-- CreateIndex
CREATE INDEX "banners_placementId_sortOrder_idx" ON "banners"("placementId", "sortOrder");

-- AddForeignKey
ALTER TABLE "banners" ADD CONSTRAINT "banners_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "banner_placements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Raw SQL ──

CREATE UNIQUE INDEX "banner_placements_code_live_key" ON "banner_placements" ("code") WHERE "deletedAt" IS NULL;
ALTER TABLE "banner_placements" ADD CONSTRAINT "banner_placements_code_upper" CHECK ("code" = upper("code"));
ALTER TABLE "banner_placements" ADD CONSTRAINT "banner_placements_max_items" CHECK ("maxItems" BETWEEN 1 AND 20);
ALTER TABLE "banners" ADD CONSTRAINT "banners_window" CHECK ("endDate" IS NULL OR "startDate" IS NULL OR "endDate" > "startDate");
ALTER TABLE "banners" ADD CONSTRAINT "banners_action_target" CHECK (("actionType" = 'NONE') = ("actionTarget" IS NULL));
