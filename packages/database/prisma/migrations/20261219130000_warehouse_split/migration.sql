-- D-57b W3.14 split / partial / backorder: one OPEN shipment per order × warehouse (was: one
-- ever). A backorder follow-up shipment can ship after the first leg left the same warehouse.
DROP INDEX IF EXISTS "warehouse_shipments_orderId_warehouseId_key";
CREATE INDEX "warehouse_shipments_orderId_warehouseId_idx" ON "warehouse_shipments" ("orderId", "warehouseId");
CREATE UNIQUE INDEX "warehouse_shipments_open_order_warehouse_key" ON "warehouse_shipments" ("orderId", "warehouseId")
  WHERE "status" IN ('PENDING_RELEASE', 'RELEASED', 'ALLOCATED', 'ASSIGNED', 'PICKING', 'PACKING', 'QC', 'READY_TO_DISPATCH');
-- Backorder queue: OPEN rows by warehouse (allocator, reconcile, ATP demand).
CREATE INDEX "warehouse_backorders_warehouseId_status_idx" ON "warehouse_backorders" ("warehouseId", "status");
