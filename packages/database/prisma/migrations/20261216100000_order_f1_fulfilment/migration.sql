-- D-57b (F1): order statuses derived from shipments + fulfilment columns.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'IN_FULFILMENT';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_DELIVERED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';

ALTER TABLE "orders"
  ADD COLUMN "customerPoRef" VARCHAR(40),
  ADD COLUMN "fulfilmentStage" VARCHAR(30),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3);
