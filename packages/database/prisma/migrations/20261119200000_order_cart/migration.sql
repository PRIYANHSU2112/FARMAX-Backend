-- CreateEnum
CREATE TYPE "CartStatus" AS ENUM ('ACTIVE', 'MERGED');

-- AlterTable
ALTER TABLE "order_variant_projections" ADD COLUMN     "availableQty" INTEGER,
ADD COLUMN     "isPrescriptionRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxOrderQty" INTEGER,
ADD COLUMN     "minOrderQty" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "stockVersion" BIGINT NOT NULL DEFAULT -1;

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "guestToken" UUID,
    "status" "CartStatus" NOT NULL DEFAULT 'ACTIVE',
    "mergedIntoId" UUID,
    "couponCode" VARCHAR(40),
    "version" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "cartId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPriceSnapshot" DECIMAL(14,2),
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("cartId","variantId")
);

-- CreateIndex
CREATE UNIQUE INDEX "carts_userId_key" ON "carts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "carts_guestToken_key" ON "carts"("guestToken");

-- CreateIndex
CREATE INDEX "carts_status_expiresAt_idx" ON "carts"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity the app relies on (race-safe SQL assumes them).
ALTER TABLE "carts" ADD CONSTRAINT "carts_owner_check"
  CHECK (("userId" IS NULL) <> ("guestToken" IS NULL));
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_qty_check" CHECK ("qty" > 0);
