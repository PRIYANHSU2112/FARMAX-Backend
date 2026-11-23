-- D-56 · warehouse-service: warehouse master + service areas move out of inventory-service.
-- inventory_warehouses / inventory_warehouse_coverage become an event-fed projection (same ids).

-- CreateEnum
CREATE TYPE "WmsAreaPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "WmsServiceAreaKind" AS ENUM ('DISTRICT', 'IMPORTED');

-- CreateEnum
CREATE TYPE "WmsWarehouseType" AS ENUM ('MOTHER', 'DEPOT');

-- CreateEnum
CREATE TYPE "WmsWarehouseStatus" AS ENUM ('SETUP', 'ACTIVE', 'LIMITED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "WmsTempClass" AS ENUM ('AMB', 'AMB_CTL', 'CC_REF', 'CC_FRZ', 'HAZ');

-- AlterTable
ALTER TABLE "inventory_warehouses" ADD COLUMN     "coverageVersion" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "createdByUserId" DROP NOT NULL,
ALTER COLUMN "updatedByUserId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "warehouse_audit_log" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "action" VARCHAR(60) NOT NULL,
    "targetType" VARCHAR(30) NOT NULL,
    "targetId" VARCHAR(64) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(500),
    "ip" VARCHAR(45),
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_service_areas" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "kind" "WmsServiceAreaKind" NOT NULL DEFAULT 'DISTRICT',
    "stateCode" CHAR(2),
    "district" VARCHAR(80),
    "priority" "WmsAreaPriority",
    "pinCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_service_area_pins" (
    "warehouseId" UUID NOT NULL,
    "pinCode" CHAR(6) NOT NULL,
    "areaId" UUID NOT NULL,
    "priorityRank" INTEGER NOT NULL,

    CONSTRAINT "warehouse_service_area_pins_pkey" PRIMARY KEY ("warehouseId","pinCode")
);

-- CreateTable
CREATE TABLE "warehouse_warehouses" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "WmsWarehouseType" NOT NULL,
    "status" "WmsWarehouseStatus" NOT NULL DEFAULT 'SETUP',
    "parentWarehouseId" UUID,
    "managerUserId" UUID,
    "phone" VARCHAR(16),
    "email" VARCHAR(254),
    "addressLine" VARCHAR(250) NOT NULL,
    "landmark" VARCHAR(120),
    "city" VARCHAR(80) NOT NULL,
    "district" VARCHAR(80),
    "stateCode" CHAR(2) NOT NULL,
    "pinCode" CHAR(6) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "totalAreaSqft" INTEGER,
    "capacityKg" DECIMAL(14,2),
    "temperatureClasses" "WmsTempClass"[],
    "isAllocatable" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "timezone" VARCHAR(40) NOT NULL DEFAULT 'Asia/Kolkata',
    "statusReason" VARCHAR(500),
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedBy" UUID,
    "activatedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3),
    "reviewFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 0,
    "coverageVersion" INTEGER NOT NULL DEFAULT 0,
    "searchText" VARCHAR(400) NOT NULL,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "warehouse_warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_status_events" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "fromStatus" "WmsWarehouseStatus",
    "toStatus" "WmsWarehouseStatus" NOT NULL,
    "reason" VARCHAR(500),
    "actorUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouse_audit_log_targetType_targetId_createdAt_idx" ON "warehouse_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "warehouse_audit_log_actorUserId_createdAt_idx" ON "warehouse_audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "warehouse_service_areas_warehouseId_idx" ON "warehouse_service_areas"("warehouseId");

-- CreateIndex
CREATE INDEX "warehouse_service_area_pins_pinCode_priorityRank_idx" ON "warehouse_service_area_pins"("pinCode", "priorityRank");

-- CreateIndex
CREATE INDEX "warehouse_service_area_pins_areaId_idx" ON "warehouse_service_area_pins"("areaId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_warehouses_code_key" ON "warehouse_warehouses"("code");

-- CreateIndex
CREATE INDEX "warehouse_warehouses_status_type_idx" ON "warehouse_warehouses"("status", "type");

-- CreateIndex
CREATE INDEX "warehouse_warehouses_parentWarehouseId_idx" ON "warehouse_warehouses"("parentWarehouseId");

-- CreateIndex
CREATE INDEX "warehouse_warehouses_stateCode_city_idx" ON "warehouse_warehouses"("stateCode", "city");

-- CreateIndex
CREATE INDEX "warehouse_status_events_warehouseId_createdAt_idx" ON "warehouse_status_events"("warehouseId", "createdAt");

-- AddForeignKey
ALTER TABLE "warehouse_service_area_pins" ADD CONSTRAINT "warehouse_service_area_pins_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "warehouse_service_areas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Hand-written: constraints Prisma cannot express, search index, append-only triggers, data copy.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "warehouse_warehouses"
  ADD CONSTRAINT "warehouse_warehouses_code_chk" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  ADD CONSTRAINT "warehouse_warehouses_pin_chk" CHECK ("pinCode" ~ '^[1-9][0-9]{5}$'),
  ADD CONSTRAINT "warehouse_warehouses_state_chk" CHECK ("stateCode" ~ '^[0-9]{2}$'),
  ADD CONSTRAINT "warehouse_warehouses_lat_chk" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "warehouse_warehouses_lng_chk" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "warehouse_warehouses_capacity_chk" CHECK ("capacityKg" IS NULL OR "capacityKg" > 0),
  ADD CONSTRAINT "warehouse_warehouses_area_chk" CHECK ("totalAreaSqft" IS NULL OR "totalAreaSqft" > 0),
  ADD CONSTRAINT "warehouse_warehouses_parent_chk" CHECK ("parentWarehouseId" IS NULL OR "parentWarehouseId" <> "id");

-- One live central (mother) warehouse: drafts discarded or deactivated do not count.
CREATE UNIQUE INDEX "warehouse_warehouses_one_mother_key" ON "warehouse_warehouses"("type")
  WHERE "type" = 'MOTHER' AND "deletedAt" IS NULL AND "status" <> 'INACTIVE';

-- "Search by name, code or location" (pg_trgm is enabled by the farm-service migration).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "warehouse_warehouses_search_trgm_idx" ON "warehouse_warehouses" USING gin ("searchText" gin_trgm_ops);

ALTER TABLE "warehouse_service_areas"
  ADD CONSTRAINT "warehouse_service_areas_kind_chk" CHECK (
    ("kind" = 'DISTRICT' AND "stateCode" IS NOT NULL AND "district" IS NOT NULL AND "priority" IS NOT NULL)
    OR ("kind" = 'IMPORTED' AND "stateCode" IS NULL AND "district" IS NULL AND "priority" IS NULL)),
  ADD CONSTRAINT "warehouse_service_areas_pincount_chk" CHECK ("pinCount" >= 0);
CREATE UNIQUE INDEX "warehouse_service_areas_district_key" ON "warehouse_service_areas"("warehouseId", "stateCode", lower("district"))
  WHERE "kind" = 'DISTRICT';
CREATE UNIQUE INDEX "warehouse_service_areas_imported_key" ON "warehouse_service_areas"("warehouseId")
  WHERE "kind" = 'IMPORTED';

ALTER TABLE "warehouse_service_area_pins"
  ADD CONSTRAINT "warehouse_service_area_pins_pin_chk" CHECK ("pinCode" ~ '^[1-9][0-9]{5}$');

-- Append-only history and audit (forbid_audit_mutation() comes from the auth migration).
CREATE TRIGGER "warehouse_status_events_append_only" BEFORE UPDATE OR DELETE ON "warehouse_status_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "warehouse_status_events_no_truncate" BEFORE TRUNCATE ON "warehouse_status_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "warehouse_audit_log_append_only" BEFORE UPDATE OR DELETE ON "warehouse_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "warehouse_audit_log_no_truncate" BEFORE TRUNCATE ON "warehouse_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- ── Data copy from inventory (facts only; nothing is guessed) ──────────────────────────────────
-- Same ids, so stock levels and reservations keep pointing at the same warehouses. Unknown data
-- (district, manager, capacity) stays empty and is listed in reviewFields; the AMB temperature
-- class is an assumption, so it is listed too. A depot's parent = the single live mother, if any.
INSERT INTO "warehouse_warehouses" (
  "id", "code", "name", "type", "status", "addressLine", "city", "stateCode", "pinCode",
  "temperatureClasses", "isAllocatable", "priority", "statusReason", "statusChangedAt",
  "activatedAt", "importedAt", "reviewFields", "version", "coverageVersion", "searchText",
  "createdByUserId", "updatedByUserId", "createdAt", "updatedAt")
SELECT w."id", w."code", w."name", w."type"::text::"WmsWarehouseType",
       CASE WHEN w."isActive" THEN 'ACTIVE' ELSE 'INACTIVE' END::"WmsWarehouseStatus",
       w."addressLine", w."city", w."stateCode", w."pinCode",
       CASE WHEN w."hasColdChain" THEN ARRAY['AMB', 'CC_REF']::"WmsTempClass"[]
            ELSE ARRAY['AMB']::"WmsTempClass"[] END,
       w."isAllocatable", w."priority", w."statusReason", w."updatedAt",
       CASE WHEN w."isActive" THEN w."createdAt" END, now(),
       ARRAY['district', 'managerUserId', 'capacityKg', 'temperatureClasses'],
       w."version", 0, lower(w."code" || ' ' || w."name" || ' ' || w."city"),
       w."createdByUserId", w."updatedByUserId", w."createdAt", now()
FROM "inventory_warehouses" w;

UPDATE "warehouse_warehouses" d
SET "parentWarehouseId" = m."id"
FROM (SELECT "id" FROM "warehouse_warehouses" WHERE "type" = 'MOTHER' AND "status" <> 'INACTIVE') m
WHERE d."type" = 'DEPOT'
  AND (SELECT count(*) FROM "warehouse_warehouses" WHERE "type" = 'MOTHER' AND "status" <> 'INACTIVE') = 1;

-- Coverage → one IMPORTED area per warehouse; every PIN keeps its exact priority (no routing change).
INSERT INTO "warehouse_service_areas" ("id", "warehouseId", "kind", "pinCount", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."warehouseId", 'IMPORTED', count(*), now(), now()
FROM "inventory_warehouse_coverage" c
GROUP BY c."warehouseId";

INSERT INTO "warehouse_service_area_pins" ("warehouseId", "pinCode", "areaId", "priorityRank")
SELECT c."warehouseId", c."pinCode", a."id", c."priority"
FROM "inventory_warehouse_coverage" c
JOIN "warehouse_service_areas" a ON a."warehouseId" = c."warehouseId" AND a."kind" = 'IMPORTED';
