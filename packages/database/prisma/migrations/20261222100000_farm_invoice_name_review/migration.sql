-- D-58b "Keep farm name & send for review": staff review of FARM_NAME invoices whose GST portal
-- names differ from the farm name. While PENDING / REJECTED the invoice uses the GST trade name.
CREATE TYPE "InvoiceNameReview" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "farms"
  ADD COLUMN "invoiceNameReview" "InvoiceNameReview",
  ADD COLUMN "invoiceNameRequestedAt" TIMESTAMP(3),
  ADD COLUMN "invoiceNameReviewedById" UUID,
  ADD COLUMN "invoiceNameReviewedAt" TIMESTAMP(3),
  ADD COLUMN "invoiceNameReviewNote" VARCHAR(500);

-- Admin queue: GET /v1/admin/farms?invoiceNameReview=PENDING
CREATE INDEX "farms_invoiceNameReview_invoiceNameRequestedAt_idx"
  ON "farms"("invoiceNameReview", "invoiceNameRequestedAt");
