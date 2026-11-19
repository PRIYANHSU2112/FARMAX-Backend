-- farm-service: farms, geo, kyc, review, audit (implementation-plan/07-farm-service.md)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

-- CreateEnum
CREATE TYPE "FarmCategory" AS ENUM ('POULTRY_FARM', 'HATCHERY', 'FEED_MILL', 'BACKYARD');

-- CreateEnum
CREATE TYPE "ProductionType" AS ENUM ('LAYER', 'BROILER', 'BROILER_BREEDER', 'LAYER_BREEDER', 'HATCHERY', 'FEED_MILL', 'BACKYARD');

-- CreateEnum
CREATE TYPE "FarmStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'NEEDS_ATTENTION', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CapacityMetric" AS ENUM ('BIRDS', 'EGGS', 'FEED_TONNES');

-- CreateEnum
CREATE TYPE "CapacityPeriod" AS ENUM ('STANDING', 'PER_CYCLE', 'PER_SETTING', 'PER_WEEK', 'PER_HOUR', 'PER_DAY', 'PER_MONTH');

-- CreateEnum
CREATE TYPE "InvoiceNameSource" AS ENUM ('FARM_NAME', 'GST_TRADE_NAME');

-- CreateEnum
CREATE TYPE "AgeBand" AS ENUM ('AGE_18_30', 'AGE_31_45', 'AGE_46_60', 'AGE_60_PLUS');

-- CreateEnum
CREATE TYPE "RegistrationChannel" AS ENUM ('SELF', 'FIELD_ASSISTED', 'ADMIN', 'IMPORT');

-- CreateEnum
CREATE TYPE "FarmActorType" AS ENUM ('OWNER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('PERSONALIZED_OFFERS', 'AADHAAR_EKYC');

-- CreateEnum
CREATE TYPE "KycDocType" AS ENUM ('PAN_CARD', 'GST_CERTIFICATE', 'ID_PROOF_FRONT', 'ID_PROOF_BACK', 'OTHER');

-- CreateEnum
CREATE TYPE "KycDocStatus" AS ENUM ('UPLOADED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "GstPortalStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'SUSPENDED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DuplicateSignal" AS ENUM ('PAN_OTHER_OWNER', 'GSTIN_OTHER_OWNER', 'GEO_SAME_OWNER', 'GEO_NAME');

-- CreateEnum
CREATE TYPE "OwnerClaim" AS ENUM ('SEPARATE_UNIT', 'SAME_FARM');

-- CreateEnum
CREATE TYPE "DuplicateCaseStatus" AS ENUM ('OPEN', 'RESOLVED_SEPARATE', 'RESOLVED_MERGED', 'RESOLVED_CHANGES', 'RESOLVED_REJECTED');

-- CreateTable
CREATE TABLE "farm_audit_log" (
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

    CONSTRAINT "farm_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "farm_owners" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fullName" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(15),
    "ageBand" "AgeBand",
    "panCipher" BYTEA,
    "panKeyId" SMALLINT,
    "panHash" CHAR(64),
    "panMasked" VARCHAR(10),
    "panVerifiedAt" TIMESTAMP(3),
    "aadhaarLast4" CHAR(4),
    "aadhaarRefId" VARCHAR(64),
    "aadhaarNameMatch" BOOLEAN,
    "aadhaarVerifiedAt" TIMESTAMP(3),
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "kycStatusChangedAt" TIMESTAMP(3),
    "personalizedOffers" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "farm_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "farms" (
    "id" UUID NOT NULL,
    "farmCode" VARCHAR(24),
    "ownerId" UUID NOT NULL,
    "category" "FarmCategory" NOT NULL,
    "productionTypes" "ProductionType"[],
    "name" VARCHAR(120) NOT NULL,
    "nameNormalized" VARCHAR(120) NOT NULL,
    "gstin" CHAR(15),
    "gstVerificationId" UUID,
    "invoiceNameSource" "InvoiceNameSource" NOT NULL DEFAULT 'FARM_NAME',
    "invoiceName" VARCHAR(200),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "gpsAccuracyM" SMALLINT,
    "locationCapturedAt" TIMESTAMP(3),
    "addressLine" VARCHAR(200),
    "village" VARCHAR(80),
    "pinCode" CHAR(6),
    "territoryId" UUID,
    "territoryCode" VARCHAR(3),
    "districtName" VARCHAR(80),
    "mandalName" VARCHAR(80),
    "primaryNodeId" UUID,
    "backupNodeId" UUID,
    "totalBirdCapacity" INTEGER,
    "status" "FarmStatus" NOT NULL DEFAULT 'DRAFT',
    "statusReason" VARCHAR(500),
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registrationStep" SMALLINT NOT NULL DEFAULT 1,
    "kycDeferredAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "mergedIntoFarmId" UUID,
    "channel" "RegistrationChannel" NOT NULL DEFAULT 'SELF',
    "createdByUserId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "farms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "farm_capacities" (
    "id" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "productionType" "ProductionType" NOT NULL,
    "metric" "CapacityMetric" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "period" "CapacityPeriod" NOT NULL,
    "rank" SMALLINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "farm_capacities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "farm_status_events" (
    "id" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "fromStatus" "FarmStatus",
    "toStatus" "FarmStatus" NOT NULL,
    "reason" VARCHAR(500),
    "actorType" "FarmActorType" NOT NULL,
    "actorUserId" UUID,
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "farm_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "farm_id_sequences" (
    "territoryCode" VARCHAR(3) NOT NULL,
    "typeCode" VARCHAR(2) NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "farm_id_sequences_pkey" PRIMARY KEY ("territoryCode","typeCode")
);

-- CreateTable
CREATE TABLE "farm_owner_consents" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "noticeVersion" VARCHAR(20) NOT NULL,
    "ip" VARCHAR(45),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "farm_owner_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "territories" (
    "id" UUID NOT NULL,
    "code" VARCHAR(3) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "districtName" VARCHAR(80) NOT NULL,
    "stateCode" CHAR(2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "territories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pin_codes" (
    "pinCode" CHAR(6) NOT NULL,
    "territoryId" UUID NOT NULL,
    "territoryCode" VARCHAR(3) NOT NULL,
    "districtName" VARCHAR(80) NOT NULL,
    "mandalName" VARCHAR(80),
    "villages" TEXT[],
    "primaryNodeId" UUID,
    "primaryNodeName" VARCHAR(80),
    "backupNodeId" UUID,
    "backupNodeName" VARCHAR(80),
    "deliveryPromise" VARCHAR(40),
    "serviceable" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pin_codes_pkey" PRIMARY KEY ("pinCode")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "farmId" UUID,
    "docType" "KycDocType" NOT NULL,
    "storageKey" VARCHAR(300) NOT NULL,
    "contentType" VARCHAR(60) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "status" "KycDocStatus" NOT NULL DEFAULT 'UPLOADED',
    "rejectionCode" VARCHAR(40),
    "rejectionNote" VARCHAR(300),
    "reviewedByUserId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "uploadedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_verifications" (
    "id" UUID NOT NULL,
    "gstin" CHAR(15) NOT NULL,
    "tradeName" VARCHAR(200),
    "legalName" VARCHAR(200) NOT NULL,
    "portalStatus" "GstPortalStatus" NOT NULL,
    "stateCode" CHAR(2) NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "requestedBy" UUID NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "farm_duplicate_cases" (
    "id" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "matchedFarmId" UUID NOT NULL,
    "matchedOwnerId" UUID NOT NULL,
    "sameOwner" BOOLEAN NOT NULL,
    "signals" "DuplicateSignal"[],
    "score" SMALLINT NOT NULL,
    "distanceM" INTEGER,
    "nameSimilarity" DECIMAL(4,3),
    "ownerClaim" "OwnerClaim",
    "ownerClaimAt" TIMESTAMP(3),
    "status" "DuplicateCaseStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToUserId" UUID,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "resolvedByUserId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "farm_duplicate_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "farm_audit_log_targetType_targetId_createdAt_idx" ON "farm_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "farm_audit_log_actorUserId_createdAt_idx" ON "farm_audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "farm_owners_userId_key" ON "farm_owners"("userId");

-- CreateIndex
CREATE INDEX "farm_owners_panHash_idx" ON "farm_owners"("panHash");

-- CreateIndex
CREATE INDEX "farm_owners_kycStatus_idx" ON "farm_owners"("kycStatus");

-- CreateIndex
CREATE UNIQUE INDEX "farms_farmCode_key" ON "farms"("farmCode");

-- CreateIndex
CREATE INDEX "farms_ownerId_status_idx" ON "farms"("ownerId", "status");

-- CreateIndex
CREATE INDEX "farms_status_id_idx" ON "farms"("status", "id");

-- CreateIndex
CREATE INDEX "farms_territoryCode_status_id_idx" ON "farms"("territoryCode", "status", "id");

-- CreateIndex
CREATE INDEX "farms_category_status_id_idx" ON "farms"("category", "status", "id");

-- CreateIndex
CREATE INDEX "farms_pinCode_idx" ON "farms"("pinCode");

-- CreateIndex
CREATE INDEX "farms_gstin_idx" ON "farms"("gstin");

-- CreateIndex
CREATE UNIQUE INDEX "farm_capacities_farmId_productionType_metric_key" ON "farm_capacities"("farmId", "productionType", "metric");

-- CreateIndex
CREATE INDEX "farm_status_events_farmId_createdAt_idx" ON "farm_status_events"("farmId", "createdAt");

-- CreateIndex
CREATE INDEX "farm_owner_consents_ownerId_purpose_createdAt_idx" ON "farm_owner_consents"("ownerId", "purpose", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "territories_code_key" ON "territories"("code");

-- CreateIndex
CREATE INDEX "pin_codes_territoryId_idx" ON "pin_codes"("territoryId");

-- CreateIndex
CREATE INDEX "kyc_documents_ownerId_docType_createdAt_idx" ON "kyc_documents"("ownerId", "docType", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "kyc_documents_farmId_idx" ON "kyc_documents"("farmId");

-- CreateIndex
CREATE INDEX "kyc_documents_status_id_idx" ON "kyc_documents"("status", "id");

-- CreateIndex
CREATE INDEX "gst_verifications_gstin_checkedAt_idx" ON "gst_verifications"("gstin", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "farm_duplicate_cases_farmId_status_idx" ON "farm_duplicate_cases"("farmId", "status");

-- CreateIndex
CREATE INDEX "farm_duplicate_cases_status_slaDueAt_idx" ON "farm_duplicate_cases"("status", "slaDueAt");

-- AddForeignKey
ALTER TABLE "farms" ADD CONSTRAINT "farms_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "farm_owners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "farm_capacities" ADD CONSTRAINT "farm_capacities_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "farm_status_events" ADD CONSTRAINT "farm_status_events_farmId_fkey" FOREIGN KEY ("farmId") REFERENCES "farms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "farm_owner_consents" ADD CONSTRAINT "farm_owner_consents_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "farm_owners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Raw SQL: search, geo, integrity (not expressible in Prisma) ──

-- Admin/customer search by partial name or Farm ID (q=...).
CREATE INDEX "farms_nameNormalized_trgm_idx" ON "farms" USING gin ("nameNormalized" gin_trgm_ops);
CREATE INDEX "farms_farmCode_trgm_idx" ON "farms" USING gin ("farmCode" gin_trgm_ops);

-- Dedupe radius search (earth_box + earth_distance) over live farms only.
CREATE INDEX "farms_geo_idx" ON "farms" USING gist (ll_to_earth("latitude"::float8, "longitude"::float8))
  WHERE "latitude" IS NOT NULL AND "deletedAt" IS NULL AND "status" IN ('UNDER_REVIEW', 'NEEDS_ATTENTION', 'ACTIVE', 'SUSPENDED');

-- Admin review queue and the duplicate-case SLA queue.
CREATE INDEX "farms_review_queue_idx" ON "farms" ("submittedAt", "id") WHERE "status" IN ('UNDER_REVIEW', 'NEEDS_ATTENTION');
CREATE INDEX "farm_duplicate_cases_open_idx" ON "farm_duplicate_cases" ("slaDueAt", "id") WHERE "status" = 'OPEN';

ALTER TABLE "farms" ADD CONSTRAINT "farms_latitude_india" CHECK ("latitude" IS NULL OR "latitude" BETWEEN 6.5 AND 37.5);
ALTER TABLE "farms" ADD CONSTRAINT "farms_longitude_india" CHECK ("longitude" IS NULL OR "longitude" BETWEEN 68 AND 97.5);
ALTER TABLE "farms" ADD CONSTRAINT "farms_active_has_code" CHECK ("status" NOT IN ('ACTIVE', 'SUSPENDED') OR "farmCode" IS NOT NULL);
ALTER TABLE "farm_capacities" ADD CONSTRAINT "farm_capacities_value_positive" CHECK ("value" > 0);
ALTER TABLE "farm_owners" ADD CONSTRAINT "farm_owners_aadhaar_last4" CHECK ("aadhaarLast4" IS NULL OR "aadhaarLast4" ~ '^[0-9]{4}$');

-- Farm ID is permanent once issued (D-25).
CREATE FUNCTION "forbid_farm_code_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."farmCode" IS NOT NULL AND NEW."farmCode" IS DISTINCT FROM OLD."farmCode" THEN
    RAISE EXCEPTION 'farmCode is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "farms_code_immutable" BEFORE UPDATE OF "farmCode" ON "farms"
  FOR EACH ROW EXECUTE FUNCTION "forbid_farm_code_change"();

-- Append-only tables (D-15 function from the init migration).
CREATE TRIGGER "farm_status_events_append_only" BEFORE UPDATE OR DELETE ON "farm_status_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "farm_status_events_no_truncate" BEFORE TRUNCATE ON "farm_status_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "farm_owner_consents_append_only" BEFORE UPDATE OR DELETE ON "farm_owner_consents"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "farm_owner_consents_no_truncate" BEFORE TRUNCATE ON "farm_owner_consents"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "farm_audit_log_append_only" BEFORE UPDATE OR DELETE ON "farm_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "farm_audit_log_no_truncate" BEFORE TRUNCATE ON "farm_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
