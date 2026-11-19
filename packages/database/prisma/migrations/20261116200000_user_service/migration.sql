-- user-service: customer addresses (soft delete, one default per user), wishlist (one row per
-- user + product) and user_audit_log (append-only, D-22). userId / productId are plain uuid
-- references to auth-service / product-service (D-21).

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('HOME', 'FARM', 'WAREHOUSE', 'OFFICE', 'OTHER');

-- CreateTable
CREATE TABLE "user_addresses" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "AddressType" NOT NULL DEFAULT 'HOME',
    "label" VARCHAR(40),
    "contactName" VARCHAR(80) NOT NULL,
    "contactPhone" VARCHAR(15) NOT NULL,
    "line1" VARCHAR(150) NOT NULL,
    "line2" VARCHAR(150),
    "landmark" VARCHAR(100),
    "village" VARCHAR(80),
    "mandal" VARCHAR(80),
    "district" VARCHAR(80) NOT NULL,
    "stateCode" CHAR(2) NOT NULL,
    "pinCode" CHAR(6) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "user_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wishlist_items" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_audit_log" (
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

    CONSTRAINT "user_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_addresses_userId_deletedAt_idx" ON "user_addresses"("userId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_items_userId_productId_key" ON "wishlist_items"("userId", "productId");

-- CreateIndex
CREATE INDEX "wishlist_items_userId_id_idx" ON "wishlist_items"("userId", "id" DESC);

-- CreateIndex
CREATE INDEX "user_audit_log_targetType_targetId_createdAt_idx" ON "user_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "user_audit_log_actorUserId_createdAt_idx" ON "user_audit_log"("actorUserId", "createdAt");

-- ── Raw SQL ──

-- Exactly one live default address per user (race-proof; the service swaps under a user lock).
CREATE UNIQUE INDEX "user_addresses_one_default" ON "user_addresses" ("userId") WHERE "isDefault" AND "deletedAt" IS NULL;

ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_pin" CHECK ("pinCode" ~ '^[1-9][0-9]{5}$');
ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_state_upper" CHECK ("stateCode" ~ '^[A-Z]{2}$');
ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_phone" CHECK ("contactPhone" ~ '^\+[1-9][0-9]{7,13}$');
ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_geo" CHECK (
  ("latitude" IS NULL) = ("longitude" IS NULL)
  AND ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90)
  AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180)
);
ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_deleted_not_default" CHECK ("deletedAt" IS NULL OR NOT "isDefault");

-- Append-only audit (D-15 function from the init migration).
CREATE TRIGGER "user_audit_log_append_only" BEFORE UPDATE OR DELETE ON "user_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "user_audit_log_no_truncate" BEFORE TRUNCATE ON "user_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
