-- CreateEnum
CREATE TYPE "WalletAccountOwner" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "WalletAccountStatus" AS ENUM ('ACTIVE', 'FROZEN');

-- CreateEnum
CREATE TYPE "WalletJournalKind" AS ENUM ('TOPUP', 'ORDER_DEBIT', 'REFUND_CREDIT', 'POINTS_CONVERSION', 'ADJUSTMENT_CREDIT', 'ADJUSTMENT_DEBIT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "WalletCategory" AS ENUM ('TOPUPS', 'PURCHASES', 'REFUNDS', 'REWARDS', 'ADJUSTMENTS');

-- CreateTable
CREATE TABLE "wallet_accounts" (
    "id" UUID NOT NULL,
    "ownerType" "WalletAccountOwner" NOT NULL,
    "userId" UUID,
    "code" VARCHAR(40),
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "balancePaise" BIGINT NOT NULL DEFAULT 0,
    "status" "WalletAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "frozenReason" VARCHAR(300),
    "frozenAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_journals" (
    "id" UUID NOT NULL,
    "journalNo" VARCHAR(24) NOT NULL,
    "kind" "WalletJournalKind" NOT NULL,
    "category" "WalletCategory" NOT NULL,
    "idempotencyKey" VARCHAR(120) NOT NULL,
    "userId" UUID NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "refType" VARCHAR(30),
    "refId" VARCHAR(64),
    "title" VARCHAR(120) NOT NULL,
    "subtitle" VARCHAR(200),
    "metadata" JSONB,
    "reversalOf" UUID,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_postings" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "journalId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "balanceAfterPaise" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_postings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_accounts_userId_key" ON "wallet_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_accounts_code_key" ON "wallet_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_journals_journalNo_key" ON "wallet_journals"("journalNo");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_journals_idempotencyKey_key" ON "wallet_journals"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_journals_reversalOf_key" ON "wallet_journals"("reversalOf");

-- CreateIndex
CREATE INDEX "wallet_journals_userId_createdAt_id_idx" ON "wallet_journals"("userId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "wallet_journals_userId_category_createdAt_idx" ON "wallet_journals"("userId", "category", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "wallet_journals_refType_refId_idx" ON "wallet_journals"("refType", "refId");

-- CreateIndex
CREATE INDEX "wallet_postings_journalId_idx" ON "wallet_postings"("journalId");

-- CreateIndex
CREATE INDEX "wallet_postings_accountId_seq_idx" ON "wallet_postings"("accountId", "seq" DESC);

-- AddForeignKey
ALTER TABLE "wallet_postings" ADD CONSTRAINT "wallet_postings_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "wallet_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_postings" ADD CONSTRAINT "wallet_postings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "wallet_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Ledger invariants (D-54). The database, not the app, is the last line of defence. ───

-- Accounts: USER rows own a non-negative balance; SYSTEM rows never carry one (derived from postings).
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_owner_chk" CHECK (
  ("ownerType" = 'USER' AND "userId" IS NOT NULL AND "code" IS NULL AND "balancePaise" >= 0)
  OR ("ownerType" = 'SYSTEM' AND "code" IS NOT NULL AND "userId" IS NULL AND "balancePaise" = 0)
);
ALTER TABLE "wallet_journals" ADD CONSTRAINT "wallet_journals_amount_chk" CHECK ("amountPaise" > 0);
ALTER TABLE "wallet_postings" ADD CONSTRAINT "wallet_postings_amount_chk" CHECK ("amountPaise" <> 0);

-- Journals and postings are append-only; accounts are never deleted.
CREATE TRIGGER "wallet_journals_append_only" BEFORE UPDATE OR DELETE ON "wallet_journals"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "wallet_journals_no_truncate" BEFORE TRUNCATE ON "wallet_journals"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "wallet_postings_append_only" BEFORE UPDATE OR DELETE ON "wallet_postings"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "wallet_postings_no_truncate" BEFORE TRUNCATE ON "wallet_postings"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "wallet_accounts_no_delete" BEFORE DELETE ON "wallet_accounts"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "wallet_accounts_no_truncate" BEFORE TRUNCATE ON "wallet_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- A frozen account can receive money but never lose it.
CREATE FUNCTION "wallet_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'FROZEN' AND NEW."balancePaise" < OLD."balancePaise" THEN
    RAISE EXCEPTION 'wallet account % is frozen', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ownerType" <> OLD."ownerType" OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'wallet account % owner is immutable', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "wallet_accounts_guard" BEFORE UPDATE ON "wallet_accounts"
  FOR EACH ROW EXECUTE FUNCTION "wallet_account_guard"();

-- USER postings form an unbroken chain: balanceAfter = previous balanceAfter + amount, and it
-- equals the account's balance at that moment (the balance UPDATE runs first, under the row lock).
-- SYSTEM postings carry no balance.
CREATE FUNCTION "wallet_posting_chain"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acct RECORD;
  prev BIGINT;
BEGIN
  SELECT "ownerType", "balancePaise" INTO acct FROM "wallet_accounts" WHERE "id" = NEW."accountId";
  IF acct."ownerType" = 'SYSTEM' THEN
    IF NEW."balanceAfterPaise" IS NOT NULL THEN
      RAISE EXCEPTION 'system posting must not carry a balance' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "balanceAfterPaise" INTO prev FROM "wallet_postings"
    WHERE "accountId" = NEW."accountId" AND "seq" < NEW."seq"
    ORDER BY "seq" DESC LIMIT 1;
  IF NEW."balanceAfterPaise" IS NULL
     OR NEW."balanceAfterPaise" <> COALESCE(prev, 0) + NEW."amountPaise"
     OR NEW."balanceAfterPaise" <> acct."balancePaise" THEN
    RAISE EXCEPTION 'wallet posting breaks the balance chain of account % (prev %, amount %, after %, account %)',
      NEW."accountId", COALESCE(prev, 0), NEW."amountPaise", NEW."balanceAfterPaise", acct."balancePaise"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "wallet_postings_chain" BEFORE INSERT ON "wallet_postings"
  FOR EACH ROW EXECUTE FUNCTION "wallet_posting_chain"();

-- At COMMIT: every journal has ≥ 2 postings summing to 0 …
CREATE FUNCTION "wallet_assert_journal_balanced"(jid UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  total NUMERIC;
  n INT;
BEGIN
  SELECT COALESCE(SUM("amountPaise"), 0), COUNT(*) INTO total, n
    FROM "wallet_postings" WHERE "journalId" = jid;
  IF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'wallet journal % is unbalanced (postings %, sum %)', jid, n, total
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
CREATE FUNCTION "wallet_journal_balanced"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "wallet_assert_journal_balanced"(NEW."id");
  RETURN NULL;
END $$;
CREATE FUNCTION "wallet_posting_journal_balanced"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "wallet_assert_journal_balanced"(NEW."journalId");
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "wallet_journals_balanced" AFTER INSERT ON "wallet_journals"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "wallet_journal_balanced"();
CREATE CONSTRAINT TRIGGER "wallet_postings_balanced" AFTER INSERT ON "wallet_postings"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "wallet_posting_journal_balanced"();

-- … and a USER balance never changes without a matching posting.
CREATE FUNCTION "wallet_account_matches_postings"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bal BIGINT;
  latest BIGINT;
BEGIN
  SELECT "balancePaise" INTO bal FROM "wallet_accounts" WHERE "id" = NEW."id";
  SELECT "balanceAfterPaise" INTO latest FROM "wallet_postings"
    WHERE "accountId" = NEW."id" ORDER BY "seq" DESC LIMIT 1;
  IF bal <> COALESCE(latest, 0) THEN
    RAISE EXCEPTION 'wallet account % balance % does not match its ledger %', NEW."id", bal, COALESCE(latest, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "wallet_accounts_match_postings" AFTER UPDATE OF "balancePaise" ON "wallet_accounts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."ownerType" = 'USER') EXECUTE FUNCTION "wallet_account_matches_postings"();

-- System accounts (counterparties of every user posting).
INSERT INTO "wallet_accounts" ("id", "ownerType", "code", "updatedAt") VALUES
  (gen_random_uuid(), 'SYSTEM', 'GATEWAY_CLEARING', now()),
  (gen_random_uuid(), 'SYSTEM', 'ORDER_SETTLEMENT', now()),
  (gen_random_uuid(), 'SYSTEM', 'REWARDS_EXPENSE', now()),
  (gen_random_uuid(), 'SYSTEM', 'ADJUSTMENT', now());
