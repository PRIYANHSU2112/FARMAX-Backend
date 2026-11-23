-- D-56: BRIN on the append-only stock ledger time column. Admin ledger lists filtered only by
-- from / to (no warehouse or variant) scan block ranges instead of the whole table; tiny index.
CREATE INDEX "inventory_stock_ledger_createdAt_idx" ON "inventory_stock_ledger" USING BRIN ("createdAt");
