-- order-service P4 (D-34, D-41, D-45): admin review SLA marker, notes, cancellations, settings.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "reviewOverdueAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "order_notes" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_cancellations" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "scope" VARCHAR(8) NOT NULL,
    "lines" JSONB NOT NULL,
    "reasonCode" VARCHAR(40) NOT NULL,
    "note" VARCHAR(500),
    "stage" VARCHAR(40) NOT NULL,
    "fee" DECIMAL(14,2) NOT NULL,
    "refundAmount" DECIMAL(14,2) NOT NULL,
    "actorType" VARCHAR(10) NOT NULL,
    "requestedBy" UUID,
    "idempotencyKey" VARCHAR(64),
    "requestHash" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_notes_orderId_createdAt_idx" ON "order_notes"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "order_cancellations_idempotencyKey_key" ON "order_cancellations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "order_cancellations_orderId_createdAt_idx" ON "order_cancellations"("orderId", "createdAt");


-- Hand-written.
CREATE TRIGGER "order_notes_append_only" BEFORE UPDATE OR DELETE ON "order_notes"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();

ALTER TABLE "order_cancellations"
  ADD CONSTRAINT "order_cancellations_money_chk" CHECK ("fee" >= 0 AND "refundAmount" >= 0);

-- Admin review queue: paid + committed orders waiting, oldest payment first.
CREATE INDEX "orders_review_queue_idx" ON "orders"("paidAt")
  WHERE "status" = 'PENDING_ADMIN_CONFIRMATION' AND "paymentStatus" = 'PAID';

INSERT INTO "order_settings" ("key", "value") VALUES
  ('adminReviewSlaHours', '4'),
  ('adminAutoRejectHours', '48'),
  ('freeCancelMinutes', '60'),
  ('cancellationFeePercent', '0'),
  ('maxBulkConfirm', '50');
