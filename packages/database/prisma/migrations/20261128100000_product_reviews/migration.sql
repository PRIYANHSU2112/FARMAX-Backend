-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "ReviewReportReason" AS ENUM ('SPAM', 'ABUSIVE', 'OFF_TOPIC', 'FAKE', 'PERSONAL_INFO', 'OTHER');

-- CreateEnum
CREATE TYPE "ReviewReportStatus" AS ENUM ('OPEN', 'UPHELD', 'DISMISSED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "ratingAvg" DECIMAL(3,2),
ADD COLUMN     "ratingCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "review_eligibilities" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderNo" VARCHAR(20) NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "reviewId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_eligibilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_reviews" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "authorName" VARCHAR(60) NOT NULL,
    "rating" SMALLINT NOT NULL,
    "title" VARCHAR(120),
    "body" VARCHAR(2000),
    "images" JSONB NOT NULL DEFAULT '[]',
    "hasImages" BOOLEAN NOT NULL DEFAULT false,
    "status" "ReviewStatus" NOT NULL,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "moderationReason" VARCHAR(500),
    "helpfulCount" INTEGER NOT NULL DEFAULT 0,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "openReportCount" INTEGER NOT NULL DEFAULT 0,
    "editCount" SMALLINT NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "moderatedByUserId" UUID,
    "moderatedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "searchText" TEXT NOT NULL DEFAULT '',
    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "searchText")) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_votes" (
    "reviewId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_votes_pkey" PRIMARY KEY ("reviewId","userId")
);

-- CreateTable
CREATE TABLE "review_reports" (
    "id" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" "ReviewReportReason" NOT NULL,
    "note" VARCHAR(500),
    "status" "ReviewReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedByUserId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_rating_summaries" (
    "productId" UUID NOT NULL,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingAvg" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "star1" INTEGER NOT NULL DEFAULT 0,
    "star2" INTEGER NOT NULL DEFAULT 0,
    "star3" INTEGER NOT NULL DEFAULT 0,
    "star4" INTEGER NOT NULL DEFAULT 0,
    "star5" INTEGER NOT NULL DEFAULT 0,
    "textCount" INTEGER NOT NULL DEFAULT 0,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_rating_summaries_pkey" PRIMARY KEY ("productId")
);

-- CreateIndex
CREATE INDEX "review_eligibilities_userId_reviewId_deliveredAt_idx" ON "review_eligibilities"("userId", "reviewId", "deliveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "review_eligibilities_userId_productId_orderId_key" ON "review_eligibilities"("userId", "productId", "orderId");

-- CreateIndex
CREATE INDEX "product_reviews_productId_status_createdAt_id_idx" ON "product_reviews"("productId", "status", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "product_reviews_productId_status_helpfulCount_id_idx" ON "product_reviews"("productId", "status", "helpfulCount" DESC, "id");

-- CreateIndex
CREATE INDEX "product_reviews_productId_status_rating_id_idx" ON "product_reviews"("productId", "status", "rating", "id");

-- CreateIndex
CREATE INDEX "product_reviews_status_createdAt_idx" ON "product_reviews"("status", "createdAt");

-- CreateIndex
CREATE INDEX "product_reviews_userId_createdAt_idx" ON "product_reviews"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "review_reports_status_createdAt_idx" ON "review_reports"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "review_reports_reviewId_userId_key" ON "review_reports"("reviewId", "userId");

-- CreateIndex
CREATE INDEX "products_status_isActive_ratingAvg_idx" ON "products"("status", "isActive", "ratingAvg");

-- AddForeignKey
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "product_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "product_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One live review per customer per product (a deleted review frees the slot).
CREATE UNIQUE INDEX "product_reviews_user_product_live_key" ON "product_reviews" ("userId", "productId") WHERE "deletedAt" IS NULL;

-- Integrity
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_rating_range" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_counts_non_negative" CHECK ("helpfulCount" >= 0 AND "reportCount" >= 0 AND "openReportCount" >= 0 AND "editCount" >= 0);
ALTER TABLE "product_rating_summaries" ADD CONSTRAINT "product_rating_summaries_non_negative" CHECK ("ratingCount" >= 0 AND "ratingSum" >= 0 AND "star1" >= 0 AND "star2" >= 0 AND "star3" >= 0 AND "star4" >= 0 AND "star5" >= 0 AND "textCount" >= 0 AND "imageCount" >= 0);

-- Admin full-text search
CREATE INDEX "product_reviews_search_vector_idx" ON "product_reviews" USING GIN ("searchVector");
