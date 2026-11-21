-- CreateEnum
CREATE TYPE "PointsAccountOwner" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PointsBucket" AS ENUM ('AVAILABLE', 'PENDING', 'DEBT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PointsJournalKind" AS ENUM ('EARN', 'CASHBACK', 'MATURE', 'CONVERT', 'EXPIRE', 'REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PointsLotSource" AS ENUM ('ORDER', 'TOPUP_CASHBACK', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PointsLotStatus" AS ENUM ('PENDING', 'AVAILABLE', 'EXHAUSTED', 'EXPIRED', 'REVERSED');

-- AlterTable
ALTER TABLE "wallet_topups" ADD COLUMN     "cashbackGrantedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "wallet_topups_status_updatedAt_idx" ON "wallet_topups"("status", "updatedAt");

-- CreateTable
CREATE TABLE "points_accounts" (
    "id" UUID NOT NULL,
    "ownerType" "PointsAccountOwner" NOT NULL,
    "userId" UUID,
    "code" VARCHAR(40),
    "availablePts" BIGINT NOT NULL DEFAULT 0,
    "pendingPts" BIGINT NOT NULL DEFAULT 0,
    "debtPts" BIGINT NOT NULL DEFAULT 0,
    "lifetimeEarned" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_journals" (
    "id" UUID NOT NULL,
    "journalNo" VARCHAR(24) NOT NULL,
    "kind" "PointsJournalKind" NOT NULL,
    "idempotencyKey" VARCHAR(120) NOT NULL,
    "userId" UUID NOT NULL,
    "points" BIGINT NOT NULL,
    "deltaPts" BIGINT NOT NULL,
    "refType" VARCHAR(30),
    "refId" VARCHAR(64),
    "title" VARCHAR(120) NOT NULL,
    "subtitle" VARCHAR(200),
    "metadata" JSONB,
    "availableAfter" BIGINT NOT NULL,
    "pendingAfter" BIGINT NOT NULL,
    "debtAfter" BIGINT NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_postings" (
    "id" UUID NOT NULL,
    "journalId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "bucket" "PointsBucket" NOT NULL,
    "points" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_lots" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sourceType" "PointsLotSource" NOT NULL,
    "sourceRef" VARCHAR(64) NOT NULL,
    "journalId" UUID NOT NULL,
    "basePaise" BIGINT NOT NULL DEFAULT 0,
    "earnedPts" BIGINT NOT NULL,
    "remainingPts" BIGINT NOT NULL,
    "reversedPts" BIGINT NOT NULL DEFAULT 0,
    "status" "PointsLotStatus" NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "expiryNoticeAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_lot_consumptions" (
    "id" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "journalId" UUID NOT NULL,
    "points" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_lot_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "points_accounts_userId_key" ON "points_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "points_accounts_code_key" ON "points_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "points_journals_journalNo_key" ON "points_journals"("journalNo");

-- CreateIndex
CREATE UNIQUE INDEX "points_journals_idempotencyKey_key" ON "points_journals"("idempotencyKey");

-- CreateIndex
CREATE INDEX "points_journals_userId_createdAt_id_idx" ON "points_journals"("userId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "points_journals_refType_refId_idx" ON "points_journals"("refType", "refId");

-- CreateIndex
CREATE INDEX "points_postings_journalId_idx" ON "points_postings"("journalId");

-- CreateIndex
CREATE INDEX "points_postings_accountId_bucket_idx" ON "points_postings"("accountId", "bucket");

-- CreateIndex
CREATE INDEX "points_lots_userId_status_expiresAt_idx" ON "points_lots"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "points_lots_status_availableAt_idx" ON "points_lots"("status", "availableAt");

-- CreateIndex
CREATE INDEX "points_lots_status_expiresAt_idx" ON "points_lots"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "points_lots_sourceType_sourceRef_key" ON "points_lots"("sourceType", "sourceRef");

-- CreateIndex
CREATE INDEX "points_lot_consumptions_lotId_idx" ON "points_lot_consumptions"("lotId");

-- CreateIndex
CREATE INDEX "points_lot_consumptions_journalId_idx" ON "points_lot_consumptions"("journalId");

-- AddForeignKey
ALTER TABLE "points_postings" ADD CONSTRAINT "points_postings_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "points_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_postings" ADD CONSTRAINT "points_postings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "points_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_lot_consumptions" ADD CONSTRAINT "points_lot_consumptions_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "points_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Reward points invariants (D-54 W4) ───

ALTER TABLE "points_accounts" ADD CONSTRAINT "points_accounts_owner_chk" CHECK (
  ("ownerType" = 'USER' AND "userId" IS NOT NULL AND "code" IS NULL
     AND "availablePts" >= 0 AND "pendingPts" >= 0 AND "debtPts" >= 0 AND "lifetimeEarned" >= 0)
  OR ("ownerType" = 'SYSTEM' AND "code" IS NOT NULL AND "userId" IS NULL
     AND "availablePts" = 0 AND "pendingPts" = 0 AND "debtPts" = 0 AND "lifetimeEarned" = 0)
);
ALTER TABLE "points_journals" ADD CONSTRAINT "points_journals_amounts_chk" CHECK (
  "points" > 0 AND "availableAfter" >= 0 AND "pendingAfter" >= 0 AND "debtAfter" >= 0
);
ALTER TABLE "points_postings" ADD CONSTRAINT "points_postings_points_chk" CHECK ("points" <> 0);
ALTER TABLE "points_lots" ADD CONSTRAINT "points_lots_amounts_chk" CHECK (
  "earnedPts" > 0 AND "remainingPts" >= 0 AND "reversedPts" >= 0
  AND "remainingPts" + "reversedPts" <= "earnedPts" AND "basePaise" >= 0
  AND "expiresAt" > "availableAt"
);
ALTER TABLE "points_lot_consumptions" ADD CONSTRAINT "points_lot_consumptions_points_chk" CHECK ("points" > 0);

-- Append-only history; accounts are never deleted.
CREATE TRIGGER "points_journals_append_only" BEFORE UPDATE OR DELETE ON "points_journals"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "points_journals_no_truncate" BEFORE TRUNCATE ON "points_journals"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "points_postings_append_only" BEFORE UPDATE OR DELETE ON "points_postings"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "points_postings_no_truncate" BEFORE TRUNCATE ON "points_postings"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "points_lot_consumptions_append_only" BEFORE UPDATE OR DELETE ON "points_lot_consumptions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "points_accounts_no_delete" BEFORE DELETE ON "points_accounts"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "points_lots_no_delete" BEFORE DELETE ON "points_lots"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();

-- SYSTEM postings use the SYSTEM bucket; USER postings never do.
CREATE FUNCTION "points_posting_bucket_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner TEXT;
BEGIN
  SELECT "ownerType"::text INTO owner FROM "points_accounts" WHERE "id" = NEW."accountId";
  IF (owner = 'SYSTEM') <> (NEW."bucket" = 'SYSTEM') THEN
    RAISE EXCEPTION 'points posting bucket % does not fit a % account', NEW."bucket", owner
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "points_postings_bucket_guard" BEFORE INSERT ON "points_postings"
  FOR EACH ROW EXECUTE FUNCTION "points_posting_bucket_guard"();

-- At COMMIT: every points journal has ≥ 1 posting and sums to 0 …
CREATE FUNCTION "points_assert_journal_balanced"(jid UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  total NUMERIC;
  n INT;
BEGIN
  SELECT COALESCE(SUM("points"), 0), COUNT(*) INTO total, n FROM "points_postings" WHERE "journalId" = jid;
  IF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'points journal % is unbalanced (postings %, sum %)', jid, n, total
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
CREATE FUNCTION "points_journal_balanced"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "points_assert_journal_balanced"(NEW."id");
  RETURN NULL;
END $$;
CREATE FUNCTION "points_posting_journal_balanced"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "points_assert_journal_balanced"(NEW."journalId");
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "points_journals_balanced" AFTER INSERT ON "points_journals"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "points_journal_balanced"();
CREATE CONSTRAINT TRIGGER "points_postings_balanced" AFTER INSERT ON "points_postings"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "points_posting_journal_balanced"();

-- … and every USER bucket equals the SUM of its postings (DEBT is stored negative).
CREATE FUNCTION "points_account_matches_postings"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a RECORD;
  av NUMERIC;
  pe NUMERIC;
  de NUMERIC;
BEGIN
  SELECT * INTO a FROM "points_accounts" WHERE "id" = NEW."id";
  SELECT COALESCE(SUM("points") FILTER (WHERE "bucket" = 'AVAILABLE'), 0),
         COALESCE(SUM("points") FILTER (WHERE "bucket" = 'PENDING'), 0),
         COALESCE(SUM("points") FILTER (WHERE "bucket" = 'DEBT'), 0)
    INTO av, pe, de FROM "points_postings" WHERE "accountId" = NEW."id";
  IF a."availablePts" <> av OR a."pendingPts" <> pe OR a."debtPts" <> -de THEN
    RAISE EXCEPTION 'points account % does not match its ledger (available %/%, pending %/%, debt %/%)',
      NEW."id", a."availablePts", av, a."pendingPts", pe, a."debtPts", -de
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "points_accounts_match_postings" AFTER UPDATE ON "points_accounts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."ownerType" = 'USER') EXECUTE FUNCTION "points_account_matches_postings"();

-- System accounts.
INSERT INTO "points_accounts" ("id", "ownerType", "code", "updatedAt") VALUES
  (gen_random_uuid(), 'SYSTEM', 'POINTS_ISSUED', now()),
  (gen_random_uuid(), 'SYSTEM', 'POINTS_REDEEMED', now()),
  (gen_random_uuid(), 'SYSTEM', 'POINTS_EXPIRED', now()),
  (gen_random_uuid(), 'SYSTEM', 'POINTS_REVERSED', now());

-- Points rules (validated on read by the settings feature).
INSERT INTO "wallet_settings" ("key", "value") VALUES
  ('pointsEarnPaisePerPoint', '1000'),
  ('pointsHoldDays', '7'),
  ('pointsExpiryMonths', '12'),
  ('pointsMinConvert', '1000'),
  ('pointsConvertStep', '100'),
  ('pointsExpiryNoticeDays', '7');
