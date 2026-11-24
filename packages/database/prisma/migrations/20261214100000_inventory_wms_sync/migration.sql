-- D-57a: inventory is fed by the WMS (warehouse.stock_changed.v1 / warehouse.thresholds_changed.v1).
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'QUALITY_RELEASE';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'QUALITY_HOLD';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'TRANSFER_IN';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'TRANSFER_OUT';
ALTER TYPE "StockLedgerType" ADD VALUE IF NOT EXISTS 'RETURN';

ALTER TABLE "inventory_stock_levels" ADD COLUMN "thresholdVersion" INTEGER NOT NULL DEFAULT 0;
