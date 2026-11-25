-- D-61 invoice hardening (order-service invoices feature).
--
-- 1. Immutability, tightened. On top of D-48 (only PDF / IRN / credit-status columns may change,
--    never DELETE / TRUNCATE):
--    * credit status only moves forward: ISSUED → PARTIALLY_CREDITED → CREDITED, and a credit
--      note itself never changes status;
--    * a stored PDF is final: pdfKey / pdfSha256 are set once (a racing renderer may only write
--      the same deterministic values), and READY never goes back.
CREATE OR REPLACE FUNCTION "forbid_tax_document_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable CONSTANT text[] := ARRAY['status', 'pdfStatus', 'pdfKey', 'pdfSha256', 'pdfAttempts',
    'pdfError', 'pdfRenderedAt', 'irn', 'ackNo', 'ackDate', 'signedQr', 'updatedAt'];
  rank_old int;
  rank_new int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax documents are immutable (delete)' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'tax documents are immutable (only PDF / IRN / credit status may change)'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."docType" = 'CREDIT_NOTE' THEN
      RAISE EXCEPTION 'a credit note never changes status' USING ERRCODE = 'P0001';
    END IF;
    rank_old := array_position(ARRAY['ISSUED', 'PARTIALLY_CREDITED', 'CREDITED'], OLD."status"::text);
    rank_new := array_position(ARRAY['ISSUED', 'PARTIALLY_CREDITED', 'CREDITED'], NEW."status"::text);
    IF rank_new < rank_old THEN
      RAISE EXCEPTION 'credit status only moves forward (% → %)', OLD."status", NEW."status"
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF OLD."pdfKey" IS NOT NULL AND NEW."pdfKey" IS DISTINCT FROM OLD."pdfKey" THEN
    RAISE EXCEPTION 'the stored PDF key is final' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."pdfSha256" IS NOT NULL AND NEW."pdfSha256" IS DISTINCT FROM OLD."pdfSha256" THEN
    RAISE EXCEPTION 'the stored PDF hash is final' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."pdfStatus" = 'READY' AND NEW."pdfStatus" <> 'READY' THEN
    RAISE EXCEPTION 'a READY PDF never goes back' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 2. Admin register search (exact order no.; per farm, newest first).
CREATE INDEX "tax_documents_orderNo_idx" ON "tax_documents"("orderNo");
CREATE INDEX "tax_documents_farmId_issuedAt_idx" ON "tax_documents"("farmId", "issuedAt" DESC);
