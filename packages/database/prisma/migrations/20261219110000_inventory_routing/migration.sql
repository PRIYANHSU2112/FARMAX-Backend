-- D-57b W3.12: warehouse coordinates in the inventory projection (NEAREST routing, distance gates).
ALTER TABLE "inventory_warehouses" ADD COLUMN "latitude" DECIMAL(9,6), ADD COLUMN "longitude" DECIMAL(9,6);
