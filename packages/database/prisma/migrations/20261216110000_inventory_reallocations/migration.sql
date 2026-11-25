-- D-57b §2a.4: idempotent warehouse reallocation of reservation lines.
CREATE TABLE "inventory_reallocations" (
    "key" VARCHAR(80) NOT NULL,
    "reservationId" UUID NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_reallocations_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "inventory_reallocations_reservationId_idx" ON "inventory_reallocations"("reservationId");

-- Allocation reconcile (§2a.3): held lines per warehouse.
CREATE INDEX IF NOT EXISTS "inventory_reservation_lines_warehouseId_reservationId_idx"
  ON "inventory_reservation_lines"("warehouseId", "reservationId");
