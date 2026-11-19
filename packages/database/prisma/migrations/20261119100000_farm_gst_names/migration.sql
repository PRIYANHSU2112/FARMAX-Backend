-- B2B GST: portal business / trade name + verification time on the farm (farm.facts_changed.v1).
ALTER TABLE "farms"
  ADD COLUMN "gstBusinessName" VARCHAR(200),
  ADD COLUMN "gstTradeName" VARCHAR(200),
  ADD COLUMN "gstVerifiedAt" TIMESTAMP(3);

-- Backfill farms that already bound a GSTIN.
UPDATE "farms" f
SET "gstBusinessName" = v."legalName",
    "gstTradeName"    = v."tradeName",
    "gstVerifiedAt"   = v."checkedAt"
FROM "gst_verifications" v
WHERE f."gstVerificationId" = v."id" AND f."gstin" IS NOT NULL;
