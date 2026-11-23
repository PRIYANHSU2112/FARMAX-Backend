-- CreateEnum
CREATE TYPE "WmsHolidayMode" AS ENUM ('CLOSED', 'LIMITED');

-- CreateEnum
CREATE TYPE "WmsCutoffType" AS ENUM ('SAME_DAY_STANDARD', 'SAME_DAY_COLD', 'NEXT_DAY');

-- CreateEnum
CREATE TYPE "WmsDockType" AS ENUM ('UNLOADING', 'LOADING', 'BOTH');

-- CreateEnum
CREATE TYPE "WmsVehicleClass" AS ENUM ('MINI_TRUCK', 'TRUCK', 'HEAVY_TRUCK', 'ANY');

-- CreateEnum
CREATE TYPE "WmsCapacityUnit" AS ENUM ('TONNES', 'PALLETS');

-- CreateEnum
CREATE TYPE "WmsBookingDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "WmsBookingStatus" AS ENUM ('PLANNED', 'IN_USE', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WmsStagingKind" AS ENUM ('INBOUND', 'OUTBOUND', 'BOTH');

-- CreateEnum
CREATE TYPE "WmsSlotStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "WmsStorageRuleType" AS ENUM ('SEGREGATION', 'HAZARD_CLASS', 'FOOD_GRADE_ZONE', 'INCOMPATIBLE');

-- CreateEnum
CREATE TYPE "WmsResourceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "WmsWorkArea" AS ENUM ('RECEIVING', 'STORAGE', 'PICKING', 'DISPATCH');

-- CreateEnum
CREATE TYPE "WmsStaffDocType" AS ENUM ('ID_PROOF', 'ADDRESS_PROOF', 'PHOTO');

-- CreateTable
CREATE TABLE "warehouse_operating_hours" (
    "warehouseId" UUID NOT NULL,
    "isoDay" SMALLINT NOT NULL,
    "isOpen" BOOLEAN NOT NULL,
    "opensAt" VARCHAR(5),
    "closesAt" VARCHAR(5),

    CONSTRAINT "warehouse_operating_hours_pkey" PRIMARY KEY ("warehouseId","isoDay")
);

-- CreateTable
CREATE TABLE "warehouse_shifts" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "startsAt" VARCHAR(5) NOT NULL,
    "endsAt" VARCHAR(5) NOT NULL,
    "overnight" BOOLEAN NOT NULL DEFAULT false,
    "breakStartsAt" VARCHAR(5),
    "breakEndsAt" VARCHAR(5),
    "isoDays" SMALLINT[],
    "teamName" VARCHAR(60),
    "dockDoorIds" UUID[],
    "status" "WmsResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_holidays" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "reason" VARCHAR(200),
    "mode" "WmsHolidayMode" NOT NULL,
    "limitedFrom" VARCHAR(5),
    "limitedTo" VARCHAR(5),
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_cutoffs" (
    "warehouseId" UUID NOT NULL,
    "type" "WmsCutoffType" NOT NULL,
    "cutoffTime" VARCHAR(5) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_cutoffs_pkey" PRIMARY KEY ("warehouseId","type")
);

-- CreateTable
CREATE TABLE "warehouse_dock_doors" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "type" "WmsDockType" NOT NULL,
    "vehicleClass" "WmsVehicleClass" NOT NULL,
    "capacityPerDay" DECIMAL(10,2) NOT NULL,
    "capacityUnit" "WmsCapacityUnit" NOT NULL,
    "opensAt" VARCHAR(5),
    "closesAt" VARCHAR(5),
    "status" "WmsResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_dock_doors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_dock_bookings" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "dockDoorId" UUID NOT NULL,
    "direction" "WmsBookingDirection" NOT NULL,
    "refNo" VARCHAR(40) NOT NULL,
    "loadQty" DECIMAL(10,2) NOT NULL,
    "loadUnit" "WmsCapacityUnit" NOT NULL,
    "plannedStart" TIMESTAMP(3) NOT NULL,
    "plannedEnd" TIMESTAMP(3) NOT NULL,
    "status" "WmsBookingStatus" NOT NULL DEFAULT 'PLANNED',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_dock_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_staging_areas" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" "WmsStagingKind" NOT NULL,
    "capacityPallets" INTEGER NOT NULL,
    "temperatureClass" "WmsTempClass" NOT NULL DEFAULT 'AMB',
    "status" "WmsResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_staging_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_yard_slots" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "vehicleClass" "WmsVehicleClass" NOT NULL DEFAULT 'ANY',
    "status" "WmsSlotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "occupiedByRef" VARCHAR(40),
    "occupiedSince" TIMESTAMP(3),
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_yard_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_storage_rules" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "type" "WmsStorageRuleType" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "subjectCategoryIds" UUID[],
    "keepAwayCategoryIds" UUID[],
    "allowedZoneId" UUID,
    "minDistanceM" DECIMAL(8,2),
    "notes" VARCHAR(500),
    "status" "WmsResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_storage_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_zones" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "temperatureClass" "WmsTempClass" NOT NULL,
    "minTempC" DECIMAL(4,1),
    "maxTempC" DECIMAL(4,1),
    "isFoodGrade" BOOLEAN NOT NULL DEFAULT false,
    "productCategoryIds" UUID[],
    "status" "WmsResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_racks" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "maxWeightKg" DECIMAL(10,2) NOT NULL,
    "volumeM3" DECIMAL(10,3) NOT NULL,
    "status" "WmsResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_racks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_bins" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "rackId" UUID NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "maxWeightKg" DECIMAL(10,2) NOT NULL,
    "volumeM3" DECIMAL(10,3) NOT NULL,
    "usedWeightKg" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "usedVolumeM3" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "status" "WmsResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_bins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_staff_profiles" (
    "warehouseId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "phone" VARCHAR(16),
    "workAreas" "WmsWorkArea"[],
    "shiftId" UUID,
    "status" "WmsResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_staff_profiles_pkey" PRIMARY KEY ("warehouseId","userId")
);

-- CreateTable
CREATE TABLE "warehouse_staff_documents" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "docType" "WmsStaffDocType" NOT NULL,
    "mediaKey" VARCHAR(300) NOT NULL,
    "mime" VARCHAR(80) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedByUserId" UUID NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_staff_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_shifts_warehouseId_name_key" ON "warehouse_shifts"("warehouseId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_holidays_warehouseId_date_key" ON "warehouse_holidays"("warehouseId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_dock_doors_warehouseId_code_key" ON "warehouse_dock_doors"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "warehouse_dock_bookings_warehouseId_plannedStart_idx" ON "warehouse_dock_bookings"("warehouseId", "plannedStart");

-- CreateIndex
CREATE INDEX "warehouse_dock_bookings_dockDoorId_status_idx" ON "warehouse_dock_bookings"("dockDoorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_staging_areas_warehouseId_name_key" ON "warehouse_staging_areas"("warehouseId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_yard_slots_warehouseId_code_key" ON "warehouse_yard_slots"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "warehouse_storage_rules_warehouseId_type_status_idx" ON "warehouse_storage_rules"("warehouseId", "type", "status");

-- CreateIndex
CREATE INDEX "warehouse_zones_warehouseId_status_idx" ON "warehouse_zones"("warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_zones_warehouseId_code_key" ON "warehouse_zones"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "warehouse_racks_zoneId_idx" ON "warehouse_racks"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_racks_warehouseId_code_key" ON "warehouse_racks"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "warehouse_bins_rackId_idx" ON "warehouse_bins"("rackId");

-- CreateIndex
CREATE INDEX "warehouse_bins_warehouseId_zoneId_status_idx" ON "warehouse_bins"("warehouseId", "zoneId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_bins_warehouseId_code_key" ON "warehouse_bins"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "warehouse_staff_profiles_warehouseId_status_idx" ON "warehouse_staff_profiles"("warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_staff_documents_warehouseId_userId_docType_key" ON "warehouse_staff_documents"("warehouseId", "userId", "docType");

-- AddForeignKey
ALTER TABLE "warehouse_dock_bookings" ADD CONSTRAINT "warehouse_dock_bookings_dockDoorId_fkey" FOREIGN KEY ("dockDoorId") REFERENCES "warehouse_dock_doors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_racks" ADD CONSTRAINT "warehouse_racks_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "warehouse_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "warehouse_racks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Hand-written (D-56 P2): value checks Prisma cannot express and the dock double-booking guard.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "warehouse_zones"
  ADD CONSTRAINT "warehouse_zones_code_chk" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  ADD CONSTRAINT "warehouse_zones_temp_chk" CHECK ("minTempC" IS NULL OR "maxTempC" IS NULL OR "minTempC" <= "maxTempC");
ALTER TABLE "warehouse_racks"
  ADD CONSTRAINT "warehouse_racks_limits_chk" CHECK ("maxWeightKg" > 0 AND "volumeM3" > 0);
ALTER TABLE "warehouse_bins"
  ADD CONSTRAINT "warehouse_bins_limits_chk" CHECK ("maxWeightKg" > 0 AND "volumeM3" > 0),
  ADD CONSTRAINT "warehouse_bins_used_chk" CHECK (
    "usedWeightKg" >= 0 AND "usedVolumeM3" >= 0 AND "usedWeightKg" <= "maxWeightKg" AND "usedVolumeM3" <= "volumeM3");

ALTER TABLE "warehouse_dock_doors"
  ADD CONSTRAINT "warehouse_dock_doors_capacity_chk" CHECK ("capacityPerDay" > 0),
  ADD CONSTRAINT "warehouse_dock_doors_hours_chk" CHECK (
    ("opensAt" IS NULL OR "opensAt" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND
    ("closesAt" IS NULL OR "closesAt" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'));
ALTER TABLE "warehouse_dock_bookings"
  ADD CONSTRAINT "warehouse_dock_bookings_window_chk" CHECK ("plannedEnd" > "plannedStart"),
  ADD CONSTRAINT "warehouse_dock_bookings_load_chk" CHECK ("loadQty" > 0);
-- One door, one booking at a time: PLANNED / IN_USE windows never overlap (btree_gist is enabled
-- by the call-service migration).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "warehouse_dock_bookings"
  ADD CONSTRAINT "warehouse_dock_bookings_no_overlap" EXCLUDE USING gist (
    "dockDoorId" WITH =,
    tsrange("plannedStart", "plannedEnd") WITH &&
  ) WHERE ("status" IN ('PLANNED', 'IN_USE'));

ALTER TABLE "warehouse_staging_areas"
  ADD CONSTRAINT "warehouse_staging_areas_capacity_chk" CHECK ("capacityPallets" > 0);

ALTER TABLE "warehouse_operating_hours"
  ADD CONSTRAINT "warehouse_operating_hours_day_chk" CHECK ("isoDay" BETWEEN 1 AND 7),
  ADD CONSTRAINT "warehouse_operating_hours_open_chk" CHECK (
    NOT "isOpen" OR ("opensAt" IS NOT NULL AND "closesAt" IS NOT NULL AND "opensAt" < "closesAt"));
ALTER TABLE "warehouse_shifts"
  ADD CONSTRAINT "warehouse_shifts_days_chk" CHECK (cardinality("isoDays") > 0 AND "isoDays" <@ ARRAY[1,2,3,4,5,6,7]::smallint[]);
ALTER TABLE "warehouse_holidays"
  ADD CONSTRAINT "warehouse_holidays_limited_chk" CHECK (
    "mode" = 'CLOSED' OR ("limitedFrom" IS NOT NULL AND "limitedTo" IS NOT NULL AND "limitedFrom" < "limitedTo"));

ALTER TABLE "warehouse_storage_rules"
  ADD CONSTRAINT "warehouse_storage_rules_distance_chk" CHECK ("minDistanceM" IS NULL OR "minDistanceM" >= 0);
ALTER TABLE "warehouse_staff_documents"
  ADD CONSTRAINT "warehouse_staff_documents_size_chk" CHECK ("sizeBytes" > 0);
