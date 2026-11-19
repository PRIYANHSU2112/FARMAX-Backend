-- order-service orders (D-34…D-45): orders, lines, status events, refund requests, sequences, settings.


-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_ADMIN_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderPaymentStatus" AS ENUM ('PENDING', 'FAILED', 'PAID', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderStockStatus" AS ENUM ('PENDING', 'RESERVED', 'COMMITTED', 'RELEASE_REQUESTED', 'RELEASED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OrderRefundStatus" AS ENUM ('NONE', 'REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'ACTION_REQUIRED');

-- CreateEnum
CREATE TYPE "OrderRefundRequestStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'COMPLETED', 'FAILED', 'RETRY_REQUESTED', 'MANUALLY_RESOLVED');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "orderNo" VARCHAR(20) NOT NULL,
    "userId" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "channel" VARCHAR(12) NOT NULL DEFAULT 'APP',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_ADMIN_CONFIRMATION',
    "failureCode" VARCHAR(40),
    "paymentStatus" "OrderPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "stockStatus" "OrderStockStatus" NOT NULL DEFAULT 'PENDING',
    "refundStatus" "OrderRefundStatus" NOT NULL DEFAULT 'NONE',
    "paymentException" VARCHAR(40),
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "itemSubtotal" DECIMAL(14,2) NOT NULL,
    "discountTotal" DECIMAL(14,2) NOT NULL,
    "taxableAmount" DECIMAL(14,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL,
    "sgst" DECIMAL(14,2) NOT NULL,
    "igst" DECIMAL(14,2) NOT NULL,
    "freight" DECIMAL(14,2) NOT NULL,
    "freightDiscount" DECIMAL(14,2) NOT NULL,
    "grandTotal" DECIMAL(14,2) NOT NULL,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "refundedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "priceTrace" JSONB NOT NULL,
    "billing" JSONB NOT NULL,
    "deliveryAddress" JSONB NOT NULL,
    "deliveryPromise" VARCHAR(40),
    "couponCode" VARCHAR(40),
    "cartVersion" INTEGER NOT NULL,
    "reservationId" UUID,
    "activePaymentId" UUID,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentDueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" UUID,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" UUID,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" UUID,
    "failedAt" TIMESTAMP(3),
    "closeReasonCode" VARCHAR(40),
    "closeReason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "variantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "name" VARCHAR(250) NOT NULL,
    "hsnCode" VARCHAR(8) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL,
    "temperatureClass" VARCHAR(10) NOT NULL,
    "qty" INTEGER NOT NULL,
    "cancelledQty" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "lineGross" DECIMAL(14,2) NOT NULL,
    "lineDiscount" DECIMAL(14,2) NOT NULL,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL,
    "sgst" DECIMAL(14,2) NOT NULL,
    "igst" DECIMAL(14,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "allocations" JSONB NOT NULL,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_events" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "field" VARCHAR(10) NOT NULL,
    "fromValue" VARCHAR(40),
    "toValue" VARCHAR(40) NOT NULL,
    "actorType" VARCHAR(10) NOT NULL,
    "actorId" UUID,
    "reasonCode" VARCHAR(40),
    "note" VARCHAR(500),
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_refund_requests" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "sourceRef" VARCHAR(80) NOT NULL,
    "paymentId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "status" "OrderRefundRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "paymentRefundId" UUID,
    "providerRefundId" VARCHAR(64),
    "expectedBy" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "arn" VARCHAR(64),
    "failureReason" VARCHAR(300),
    "requestedBy" UUID,
    "resolvedBy" UUID,
    "resolutionRef" VARCHAR(80),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_refund_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_sequences" (
    "kind" VARCHAR(8) NOT NULL,
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "order_sequences_pkey" PRIMARY KEY ("kind","year")
);

-- CreateTable
CREATE TABLE "order_settings" (
    "key" VARCHAR(60) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNo_key" ON "orders"("orderNo");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotencyKey_key" ON "orders"("idempotencyKey");

-- CreateIndex
CREATE INDEX "orders_userId_placedAt_idx" ON "orders"("userId", "placedAt" DESC);

-- CreateIndex
CREATE INDEX "orders_farmId_idx" ON "orders"("farmId");

-- CreateIndex
CREATE INDEX "orders_status_paymentStatus_stockStatus_placedAt_idx" ON "orders"("status", "paymentStatus", "stockStatus", "placedAt");

-- CreateIndex
CREATE INDEX "order_lines_variantId_idx" ON "order_lines"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_orderId_lineNo_key" ON "order_lines"("orderId", "lineNo");

-- CreateIndex
CREATE INDEX "order_status_events_orderId_at_idx" ON "order_status_events"("orderId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "order_refund_requests_sourceRef_key" ON "order_refund_requests"("sourceRef");

-- CreateIndex
CREATE INDEX "order_refund_requests_orderId_idx" ON "order_refund_requests"("orderId");

-- CreateIndex
CREATE INDEX "order_refund_requests_status_createdAt_idx" ON "order_refund_requests"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Hand-written invariants.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_money_chk" CHECK (
    "grandTotal" >= 0 AND "paidAmount" >= 0 AND "refundedAmount" >= 0
    AND "refundedAmount" <= "paidAmount"
  );

ALTER TABLE "order_lines"
  ADD CONSTRAINT "order_lines_qty_chk" CHECK ("qty" > 0 AND "cancelledQty" >= 0 AND "cancelledQty" <= "qty");

ALTER TABLE "order_refund_requests" ADD CONSTRAINT "order_refund_requests_amount_chk" CHECK ("amount" > 0);

-- Timeout sweep: unpaid open orders by due time.
CREATE INDEX "orders_unpaid_due_idx" ON "orders"("paymentDueAt")
  WHERE "status" = 'PENDING_ADMIN_CONFIRMATION' AND "paymentStatus" IN ('PENDING', 'FAILED');

-- Stuck-placement sweep: reservation outcome unknown.
CREATE INDEX "orders_stock_pending_idx" ON "orders"("placedAt")
  WHERE "status" = 'PENDING_ADMIN_CONFIRMATION' AND "stockStatus" = 'PENDING';

-- Status events are append-only.
CREATE TRIGGER "order_status_events_append_only" BEFORE UPDATE OR DELETE ON "order_status_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "order_status_events_no_truncate" BEFORE TRUNCATE ON "order_status_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- Default settings (editable by an admin API in P4).
INSERT INTO "order_settings" ("key", "value") VALUES
  ('paymentWindowMinutes', '30'),
  ('paymentGraceSeconds', '120'),
  ('maxOrderLines', '50');
