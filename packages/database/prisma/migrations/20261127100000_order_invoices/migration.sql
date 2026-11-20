-- CreateEnum
CREATE TYPE "TaxDocumentType" AS ENUM ('TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "TaxDocumentStatus" AS ENUM ('ISSUED', 'PARTIALLY_CREDITED', 'CREDITED');

-- CreateEnum
CREATE TYPE "TaxDocumentPdfStatus" AS ENUM ('PENDING', 'RENDERING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "GstSupplyType" AS ENUM ('INTRA', 'INTER');

-- CreateTable
CREATE TABLE "tax_documents" (
    "id" UUID NOT NULL,
    "docType" "TaxDocumentType" NOT NULL,
    "docNo" VARCHAR(16) NOT NULL,
    "series" VARCHAR(8) NOT NULL,
    "fy" CHAR(4) NOT NULL,
    "status" "TaxDocumentStatus" NOT NULL DEFAULT 'ISSUED',
    "orderId" UUID NOT NULL,
    "orderNo" VARCHAR(20) NOT NULL,
    "shipmentId" UUID,
    "originalDocId" UUID,
    "userId" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "sellerGstin" CHAR(15) NOT NULL,
    "sellerStateCode" CHAR(2) NOT NULL,
    "buyerGstin" CHAR(15),
    "placeOfSupply" CHAR(2) NOT NULL,
    "supplyType" "GstSupplyType" NOT NULL,
    "gstr1Section" VARCHAR(8) NOT NULL,
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "taxablePaise" BIGINT NOT NULL,
    "cgstPaise" BIGINT NOT NULL,
    "sgstPaise" BIGINT NOT NULL,
    "igstPaise" BIGINT NOT NULL,
    "totalTaxPaise" BIGINT NOT NULL,
    "roundOffPaise" BIGINT NOT NULL DEFAULT 0,
    "grandTotalPaise" BIGINT NOT NULL,
    "amountInWords" VARCHAR(300) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotSha256" CHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(100) NOT NULL,
    "reason" VARCHAR(300),
    "pdfStatus" "TaxDocumentPdfStatus" NOT NULL DEFAULT 'PENDING',
    "pdfKey" VARCHAR(200),
    "pdfSha256" CHAR(64),
    "pdfAttempts" INTEGER NOT NULL DEFAULT 0,
    "pdfError" VARCHAR(300),
    "pdfRenderedAt" TIMESTAMP(3),
    "irn" VARCHAR(64),
    "ackNo" VARCHAR(20),
    "ackDate" TIMESTAMP(3),
    "signedQr" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "issuedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_document_lines" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "orderLineNo" INTEGER,
    "variantId" UUID,
    "sku" VARCHAR(40),
    "description" VARCHAR(250) NOT NULL,
    "hsnSac" VARCHAR(8) NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPricePaise" BIGINT NOT NULL,
    "grossPaise" BIGINT NOT NULL,
    "discountPaise" BIGINT NOT NULL,
    "taxablePaise" BIGINT NOT NULL,
    "gstRateBp" INTEGER NOT NULL,
    "cgstPaise" BIGINT NOT NULL,
    "sgstPaise" BIGINT NOT NULL,
    "igstPaise" BIGINT NOT NULL,
    "totalPaise" BIGINT NOT NULL,

    CONSTRAINT "tax_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "sellerGstin" CHAR(15) NOT NULL,
    "series" VARCHAR(8) NOT NULL,
    "fy" CHAR(4) NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("sellerGstin","series","fy")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_documents_docNo_key" ON "tax_documents"("docNo");

-- CreateIndex
CREATE UNIQUE INDEX "tax_documents_idempotencyKey_key" ON "tax_documents"("idempotencyKey");

-- CreateIndex
CREATE INDEX "tax_documents_orderId_idx" ON "tax_documents"("orderId");

-- CreateIndex
CREATE INDEX "tax_documents_userId_issuedAt_idx" ON "tax_documents"("userId", "issuedAt" DESC);

-- CreateIndex
CREATE INDEX "tax_documents_issuedAt_id_idx" ON "tax_documents"("issuedAt", "id");

-- CreateIndex
CREATE INDEX "tax_documents_docType_status_idx" ON "tax_documents"("docType", "status");

-- CreateIndex
CREATE INDEX "tax_documents_originalDocId_idx" ON "tax_documents"("originalDocId");

-- CreateIndex
CREATE INDEX "tax_document_lines_orderId_orderLineNo_idx" ON "tax_document_lines"("orderId", "orderLineNo");

-- CreateIndex
CREATE UNIQUE INDEX "tax_document_lines_documentId_lineNo_key" ON "tax_document_lines"("documentId", "lineNo");

-- AddForeignKey
ALTER TABLE "tax_document_lines" ADD CONSTRAINT "tax_document_lines_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "tax_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Money sanity: never negative; the header is the sum of its lines (checked again in the app).
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_amounts_non_negative" CHECK (
  "taxablePaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0 AND "igstPaise" >= 0
  AND "grandTotalPaise" >= 0
);
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_supply_tax" CHECK (
  ("supplyType" = 'INTRA' AND "igstPaise" = 0) OR ("supplyType" = 'INTER' AND "cgstPaise" = 0 AND "sgstPaise" = 0)
);
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_credit_note_has_original" CHECK (
  ("docType" = 'CREDIT_NOTE') = ("originalDocId" IS NOT NULL)
);
ALTER TABLE "tax_document_lines" ADD CONSTRAINT "tax_document_lines_amounts" CHECK (
  "qty" > 0 AND "taxablePaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0 AND "igstPaise" >= 0
  AND "totalPaise" = "taxablePaise" + "cgstPaise" + "sgstPaise" + "igstPaise"
);

-- PDF render queue (PENDING / FAILED / stale RENDERING).
CREATE INDEX "tax_documents_pdf_due_idx" ON "tax_documents"("updatedAt")
  WHERE "pdfStatus" IN ('PENDING', 'RENDERING', 'FAILED');

-- Issued documents are immutable: only PDF, e-invoice (IRN) and credit-status columns may
-- change; nothing may be deleted. (GST: never edit an invoice; correct it with a credit note.)
CREATE FUNCTION "forbid_tax_document_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable CONSTANT text[] := ARRAY['status', 'pdfStatus', 'pdfKey', 'pdfSha256', 'pdfAttempts',
    'pdfError', 'pdfRenderedAt', 'irn', 'ackNo', 'ackDate', 'signedQr', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax documents are immutable (delete)' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'tax documents are immutable (only PDF / IRN / credit status may change)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "tax_documents_immutable" BEFORE UPDATE OR DELETE ON "tax_documents"
  FOR EACH ROW EXECUTE FUNCTION "forbid_tax_document_change"();
CREATE TRIGGER "tax_documents_no_truncate" BEFORE TRUNCATE ON "tax_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "tax_document_lines_append_only" BEFORE UPDATE OR DELETE ON "tax_document_lines"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "tax_document_lines_no_truncate" BEFORE TRUNCATE ON "tax_document_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
