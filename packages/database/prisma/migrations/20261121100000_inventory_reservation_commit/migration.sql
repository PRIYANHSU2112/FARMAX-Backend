-- inventory-service (D-36): reservations are committed on payment (no expiry) and issued at dispatch.
-- Hand-written: the enum value is RENAMED (not recreated) so the partial unique index on
-- "orderRef" (status IN ('ACTIVE','CONFIRMED')) keeps working and now reads ('ACTIVE','COMMITTED').

ALTER TYPE "StockReservationStatus" RENAME VALUE 'CONFIRMED' TO 'COMMITTED';
ALTER TYPE "StockReservationStatus" ADD VALUE 'ISSUED' AFTER 'COMMITTED';
ALTER TYPE "StockReservationStatus" ADD VALUE 'REJECTED';

ALTER TABLE "inventory_reservations" RENAME COLUMN "confirmedAt" TO "committedAt";
ALTER TABLE "inventory_reservations"
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "issuedAt" TIMESTAMP(3);

ALTER TABLE "inventory_reservation_lines"
  ADD COLUMN "releasedQty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "issuedQty" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "inventory_reservation_lines_held_chk"
    CHECK ("releasedQty" >= 0 AND "issuedQty" >= 0 AND "releasedQty" + "issuedQty" <= "qty");

ALTER TABLE "inventory_warehouses" ADD COLUMN "hasColdChain" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "inventory_variant_projections"
  ADD COLUMN "temperatureClass" VARCHAR(10) NOT NULL DEFAULT 'AMB';

-- Orphan sweep / admin lists: committed reservations by age.
CREATE INDEX "inventory_reservations_committed_idx" ON "inventory_reservations"("committedAt")
  WHERE "status" = 'COMMITTED';
