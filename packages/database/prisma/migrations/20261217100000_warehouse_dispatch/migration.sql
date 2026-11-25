-- CreateEnum
CREATE TYPE "WmsCarrierType" AS ENUM ('OWN_FLEET', 'THREE_PL');

-- CreateEnum
CREATE TYPE "WmsFleetStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "WmsKycStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WmsTripType" AS ENUM ('STANDARD', 'BULK');

-- CreateEnum
CREATE TYPE "WmsTripStatus" AS ENUM ('PLANNED', 'LOADING', 'DEPARTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WmsDockEquipment" AS ENUM ('STANDARD', 'HOPPER', 'CONVEYOR', 'SCALE', 'WEIGHBRIDGE');

-- AlterTable
ALTER TABLE "warehouse_dock_doors" ADD COLUMN     "equipment" "WmsDockEquipment" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "warehouse_shipments" ADD COLUMN     "dispatchId" UUID;

-- AlterTable
ALTER TABLE "warehouse_staff_profiles" ADD COLUMN     "jobTitle" VARCHAR(80);

-- AlterTable
ALTER TABLE "warehouse_warehouses" ADD COLUMN     "tagline" VARCHAR(80);

-- AlterTable
ALTER TABLE "warehouse_zones" ADD COLUMN     "isSecure" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "warehouse_dispatch_routes" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "corridorName" VARCHAR(120),
    "pinCodes" TEXT[],
    "districts" TEXT[],
    "stops" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_dispatch_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_dispatch_carriers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "WmsCarrierType" NOT NULL,
    "phone" VARCHAR(20),
    "gstin" VARCHAR(15),
    "status" "WmsFleetStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_dispatch_carriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_dispatch_vehicles" (
    "id" UUID NOT NULL,
    "regNo" VARCHAR(20) NOT NULL,
    "carrierId" UUID,
    "warehouseId" UUID,
    "vehicleClass" "WmsVehicleClass" NOT NULL,
    "capacityKg" DECIMAL(10,2) NOT NULL,
    "refrigerated" BOOLEAN NOT NULL DEFAULT false,
    "sensorsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "WmsFleetStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_dispatch_vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_dispatch_drivers" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "licenceNo" VARCHAR(30),
    "kycStatus" "WmsKycStatus" NOT NULL DEFAULT 'PENDING',
    "carrierId" UUID,
    "warehouseId" UUID,
    "status" "WmsFleetStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_dispatch_drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_dispatch_trips" (
    "id" UUID NOT NULL,
    "tripNo" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "type" "WmsTripType" NOT NULL DEFAULT 'STANDARD',
    "status" "WmsTripStatus" NOT NULL DEFAULT 'PLANNED',
    "vehicleId" UUID,
    "driverId" UUID,
    "carrierId" UUID,
    "routeId" UUID,
    "dockDoorId" UUID,
    "dockBookingId" UUID,
    "routeStops" JSONB NOT NULL DEFAULT '[]',
    "loadedPct" INTEGER NOT NULL DEFAULT 0,
    "plannedDepartAt" TIMESTAMP(3),
    "gateInAt" TIMESTAMP(3),
    "loadingStartedAt" TIMESTAMP(3),
    "departedAt" TIMESTAMP(3),
    "etaAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "grossKg" DECIMAL(12,2),
    "tareKg" DECIMAL(12,2),
    "netKg" DECIMAL(12,2),
    "weighSlipNo" VARCHAR(40),
    "weighSlipMediaKey" VARCHAR(300),
    "weighedAt" TIMESTAMP(3),
    "weightVerified" BOOLEAN,
    "lastPingAt" TIMESTAMP(3),
    "lastLat" DECIMAL(9,6),
    "lastLng" DECIMAL(9,6),
    "lastSpeedKmh" DECIMAL(6,1),
    "remainingKm" DECIMAL(8,1),
    "network" VARCHAR(10),
    "note" VARCHAR(500),
    "createdBy" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_dispatch_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_dispatch_trip_shipments" (
    "tripId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "plannedKg" DECIMAL(12,2),
    "loadedKg" DECIMAL(12,2),

    CONSTRAINT "warehouse_dispatch_trip_shipments_pkey" PRIMARY KEY ("tripId","shipmentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_dispatch_routes_warehouseId_code_key" ON "warehouse_dispatch_routes"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_dispatch_vehicles_regNo_key" ON "warehouse_dispatch_vehicles"("regNo");

-- CreateIndex
CREATE INDEX "warehouse_dispatch_vehicles_warehouseId_status_idx" ON "warehouse_dispatch_vehicles"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "warehouse_dispatch_drivers_warehouseId_status_idx" ON "warehouse_dispatch_drivers"("warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_dispatch_trips_tripNo_key" ON "warehouse_dispatch_trips"("tripNo");

-- CreateIndex
CREATE INDEX "warehouse_dispatch_trips_warehouseId_status_plannedDepartAt_idx" ON "warehouse_dispatch_trips"("warehouseId", "status", "plannedDepartAt" DESC);

-- CreateIndex
CREATE INDEX "warehouse_dispatch_trips_vehicleId_status_idx" ON "warehouse_dispatch_trips"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "warehouse_dispatch_trips_driverId_status_idx" ON "warehouse_dispatch_trips"("driverId", "status");

-- CreateIndex
CREATE INDEX "warehouse_dispatch_trip_shipments_shipmentId_idx" ON "warehouse_dispatch_trip_shipments"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_shipments_dispatchId_key" ON "warehouse_shipments"("dispatchId");

-- AddForeignKey
ALTER TABLE "warehouse_dispatch_trip_shipments" ADD CONSTRAINT "warehouse_dispatch_trip_shipments_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "warehouse_dispatch_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-written (D-57b Phase 4a) ──
-- GPS pings: monthly range partitions on "at" (ping-retention job adds months, drops > 90 days).
CREATE TABLE "warehouse_dispatch_trip_pings" (
    "tripId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "lat" DECIMAL(9,6) NOT NULL,
    "lng" DECIMAL(9,6) NOT NULL,
    "speedKmh" DECIMAL(6,1),
    "remainingKm" DECIMAL(8,1),
    "network" VARCHAR(10),
    "source" VARCHAR(12) NOT NULL,
    CONSTRAINT "warehouse_dispatch_trip_pings_pkey" PRIMARY KEY ("tripId", "at")
) PARTITION BY RANGE ("at");
CREATE TABLE "warehouse_dispatch_trip_pings_default" PARTITION OF "warehouse_dispatch_trip_pings" DEFAULT;
DO $$
DECLARE m date := date_trunc('month', now())::date;
BEGIN
  FOR i IN 0..2 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "warehouse_dispatch_trip_pings" FOR VALUES FROM (%L) TO (%L)',
      'warehouse_dispatch_trip_pings_' || to_char(m + (i || ' month')::interval, 'YYYYMM'),
      m + (i || ' month')::interval,
      m + ((i + 1) || ' month')::interval);
  END LOOP;
END $$;

-- Route lookup by delivery PIN.
CREATE INDEX "warehouse_dispatch_routes_pins_gin" ON "warehouse_dispatch_routes" USING GIN ("pinCodes");
ALTER TABLE "warehouse_dispatch_trips" ADD CONSTRAINT "warehouse_dispatch_trips_loaded_check" CHECK ("loadedPct" BETWEEN 0 AND 100);
