-- D-54 W3: pay an order in full from the FarmX wallet (wallet OR gateway, never split).

-- CreateEnum
CREATE TYPE "OrderPaymentMethod" AS ENUM ('ONLINE', 'WALLET');

-- AlterEnum
ALTER TYPE "PaymentProvider" ADD VALUE 'WALLET';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "paymentMethod" "OrderPaymentMethod" NOT NULL DEFAULT 'ONLINE';

-- The wallet can pay an order, never a wallet top-up (text compare: the new enum value cannot be
-- used in the transaction that adds it).
ALTER TABLE "payments" ADD CONSTRAINT "payments_wallet_order_only_chk"
  CHECK ("provider"::text <> 'WALLET' OR "purpose" = 'ORDER');
