-- Per-node breakdown key of the last published availability (dedup of byNode publishes).
-- Existing rows get '' → the next recompute of each variant re-publishes once with byNode.

-- AlterTable
ALTER TABLE "inventory_availability_state" ADD COLUMN "nodeStockKey" TEXT NOT NULL DEFAULT '';

-- Backfill: mark every stocked variant dirty so the publisher sends one event with byNode.
INSERT INTO "inventory_availability_dirty" ("variantId")
SELECT DISTINCT "variantId" FROM "inventory_stock_levels"
ON CONFLICT ("variantId") DO NOTHING;
