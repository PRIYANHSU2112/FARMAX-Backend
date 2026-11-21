-- CreateEnum
CREATE TYPE "CallBookingStatus" AS ENUM ('HELD', 'EXPIRED', 'RELEASED', 'CONFIRMED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'RESCHEDULED', 'NO_SHOW', 'MISSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CallLeadTier" AS ENUM ('SQL', 'MQL', 'ENQUIRY');

-- CreateEnum
CREATE TYPE "CallConsentType" AS ENUM ('ROUTING', 'SHARE_WITH_BRAND', 'RECORDING');

-- CreateEnum
CREATE TYPE "CallAttemptResult" AS ENUM ('CONNECTED', 'NO_ANSWER', 'BUSY', 'FAILED');

-- CreateEnum
CREATE TYPE "CallParty" AS ENUM ('CUSTOMER', 'EXPERT', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ExpertType" AS ENUM ('VET', 'SALES_REP', 'SPECIALIST');

-- CreateEnum
CREATE TYPE "CallChannel" AS ENUM ('VIDEO', 'PHONE', 'FARM_VISIT');

-- CreateEnum
CREATE TYPE "CallOptionType" AS ENUM ('CHANNEL', 'INTENT', 'TIMEFRAME', 'LANGUAGE', 'CANCEL_REASON', 'DISPOSITION');

-- CreateTable
CREATE TABLE "call_audit_log" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "action" VARCHAR(60) NOT NULL,
    "targetType" VARCHAR(30) NOT NULL,
    "targetId" VARCHAR(64) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(500),
    "ip" VARCHAR(45),
    "requestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_bookings" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20),
    "customerUserId" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "brandId" UUID,
    "categoryId" UUID,
    "expertId" UUID NOT NULL,
    "channel" "CallChannel" NOT NULL,
    "language" VARCHAR(8) NOT NULL,
    "territoryCode" VARCHAR(3),
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "blockedStartAt" TIMESTAMP(3) NOT NULL,
    "blockedEndAt" TIMESTAMP(3) NOT NULL,
    "bufferBeforeMin" SMALLINT NOT NULL,
    "bufferAfterMin" SMALLINT NOT NULL,
    "status" "CallBookingStatus" NOT NULL,
    "holdExpiresAt" TIMESTAMP(3),
    "intents" VARCHAR(40)[],
    "question" VARCHAR(500),
    "quantity" INTEGER NOT NULL,
    "quantityUnit" VARCHAR(30),
    "timeframe" VARCHAR(40),
    "unitPrice" DECIMAL(14,2),
    "priceVersion" VARCHAR(64),
    "quotedAt" TIMESTAMP(3),
    "priceTrace" JSONB,
    "productSnapshot" JSONB,
    "farmSnapshot" JSONB,
    "leadScore" SMALLINT,
    "leadTier" "CallLeadTier",
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "attemptCount" SMALLINT NOT NULL DEFAULT 0,
    "reminderEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reminderAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "ackDueAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "slaBreachedAt" TIMESTAMP(3),
    "telephonySessionId" VARCHAR(120),
    "disposition" VARCHAR(40),
    "outcomeNote" VARCHAR(1000),
    "cancelReason" VARCHAR(40),
    "cancelledBy" "CallParty",
    "rescheduledFromId" UUID,
    "rescheduleCount" SMALLINT NOT NULL DEFAULT 0,
    "attributedOrderId" UUID,
    "attributedAt" TIMESTAMP(3),
    "finalAt" TIMESTAMP(3),
    "erasedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_booking_events" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "fromStatus" "CallBookingStatus",
    "toStatus" "CallBookingStatus" NOT NULL,
    "kind" VARCHAR(40),
    "actorType" "CallParty" NOT NULL,
    "actorId" UUID,
    "note" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_booking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_consents" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "type" "CallConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "policyVersion" VARCHAR(20) NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "actorType" "CallParty" NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_attempts" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "attemptNo" SMALLINT NOT NULL,
    "side" "CallParty",
    "result" "CallAttemptResult" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "providerEventId" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "ExpertType" NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "title" VARCHAR(120),
    "qualification" VARCHAR(120),
    "photoUrl" VARCHAR(500),
    "experienceYears" SMALLINT,
    "languages" VARCHAR(8)[],
    "brandIds" UUID[],
    "categoryIds" UUID[],
    "productionTypes" VARCHAR(24)[],
    "territoryCodes" VARCHAR(3)[],
    "channels" "CallChannel"[],
    "ratingAvg" DECIMAL(3,2),
    "onTimePct" SMALLINT,
    "maxPerDay" SMALLINT NOT NULL DEFAULT 12,
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "isBookable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastAssignedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "experts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expert_availability_rules" (
    "id" UUID NOT NULL,
    "expertId" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "startMinute" SMALLINT NOT NULL,
    "endMinute" SMALLINT NOT NULL,
    "channels" "CallChannel"[],
    "validFrom" DATE,
    "validTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expert_availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expert_breaks" (
    "id" UUID NOT NULL,
    "expertId" UUID NOT NULL,
    "weekday" SMALLINT,
    "startMinute" SMALLINT NOT NULL,
    "endMinute" SMALLINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expert_breaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expert_time_offs" (
    "id" UUID NOT NULL,
    "expertId" UUID NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" VARCHAR(200),
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expert_time_offs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_holidays" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "territoryCode" VARCHAR(3),
    "name" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_options" (
    "id" UUID NOT NULL,
    "type" "CallOptionType" NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "icon" VARCHAR(40),
    "sortOrder" SMALLINT NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "meta" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_settings" (
    "key" VARCHAR(60) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "call_audit_log_targetType_targetId_createdAt_idx" ON "call_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "call_audit_log_actorUserId_createdAt_idx" ON "call_audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "call_bookings_code_key" ON "call_bookings"("code");

-- CreateIndex
CREATE INDEX "call_bookings_customerUserId_startAt_id_idx" ON "call_bookings"("customerUserId", "startAt" DESC, "id");

-- CreateIndex
CREATE INDEX "call_bookings_expertId_startAt_idx" ON "call_bookings"("expertId", "startAt");

-- CreateIndex
CREATE INDEX "call_bookings_status_holdExpiresAt_idx" ON "call_bookings"("status", "holdExpiresAt");

-- CreateIndex
CREATE INDEX "call_bookings_status_reminderAt_idx" ON "call_bookings"("status", "reminderAt");

-- CreateIndex
CREATE INDEX "call_bookings_status_ackDueAt_idx" ON "call_bookings"("status", "ackDueAt");

-- CreateIndex
CREATE INDEX "call_bookings_status_startAt_idx" ON "call_bookings"("status", "startAt");

-- CreateIndex
CREATE INDEX "call_bookings_productId_createdAt_idx" ON "call_bookings"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "call_booking_events_bookingId_createdAt_idx" ON "call_booking_events"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "call_consents_bookingId_type_createdAt_idx" ON "call_consents"("bookingId", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "call_attempts_providerEventId_key" ON "call_attempts"("providerEventId");

-- CreateIndex
CREATE INDEX "call_attempts_bookingId_attemptNo_idx" ON "call_attempts"("bookingId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "experts_userId_key" ON "experts"("userId");

-- CreateIndex
CREATE INDEX "experts_type_isActive_isBookable_idx" ON "experts"("type", "isActive", "isBookable");

-- CreateIndex
CREATE INDEX "experts_brandIds_idx" ON "experts" USING GIN ("brandIds");

-- CreateIndex
CREATE INDEX "experts_categoryIds_idx" ON "experts" USING GIN ("categoryIds");

-- CreateIndex
CREATE INDEX "experts_languages_idx" ON "experts" USING GIN ("languages");

-- CreateIndex
CREATE INDEX "expert_availability_rules_expertId_weekday_idx" ON "expert_availability_rules"("expertId", "weekday");

-- CreateIndex
CREATE INDEX "expert_breaks_expertId_idx" ON "expert_breaks"("expertId");

-- CreateIndex
CREATE INDEX "expert_time_offs_expertId_startAt_idx" ON "expert_time_offs"("expertId", "startAt");

-- CreateIndex
CREATE INDEX "call_holidays_date_idx" ON "call_holidays"("date");

-- CreateIndex
CREATE INDEX "call_options_type_isActive_sortOrder_idx" ON "call_options"("type", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "call_options_type_code_key" ON "call_options"("type", "code");

-- AddForeignKey
ALTER TABLE "call_booking_events" ADD CONSTRAINT "call_booking_events_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "call_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_consents" ADD CONSTRAINT "call_consents_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "call_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "call_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_availability_rules" ADD CONSTRAINT "expert_availability_rules_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "experts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_breaks" ADD CONSTRAINT "expert_breaks_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "experts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_time_offs" ADD CONSTRAINT "expert_time_offs_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "experts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────── D-53 call-service: constraints Prisma cannot express ─────────────────────────
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- VET profiles feed the recommended-expert card only; they can never enter a booking pool.
ALTER TABLE "experts" ADD CONSTRAINT "experts_vet_not_bookable" CHECK ("type" <> 'VET' OR NOT "isBookable");
ALTER TABLE "experts" ADD CONSTRAINT "experts_max_per_day_chk" CHECK ("maxPerDay" BETWEEN 1 AND 48);
ALTER TABLE "expert_availability_rules" ADD CONSTRAINT "expert_availability_rules_chk"
  CHECK ("weekday" BETWEEN 0 AND 6 AND "startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute");
ALTER TABLE "expert_breaks" ADD CONSTRAINT "expert_breaks_chk"
  CHECK (("weekday" IS NULL OR "weekday" BETWEEN 0 AND 6) AND "startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute");
ALTER TABLE "expert_time_offs" ADD CONSTRAINT "expert_time_offs_chk" CHECK ("startAt" < "endAt");
ALTER TABLE "call_bookings" ADD CONSTRAINT "call_bookings_time_chk"
  CHECK ("startAt" < "endAt" AND "blockedStartAt" <= "startAt" AND "blockedEndAt" >= "endAt" AND "quantity" > 0);

-- No double booking (holds + live bookings, buffers included). Timestamps are UTC timestamp(3) → tsrange.
-- Inserts use ON CONFLICT DO NOTHING (arbiter = any constraint) and try the next rep.
ALTER TABLE "call_bookings" ADD CONSTRAINT "call_bookings_no_overlap" EXCLUDE USING gist (
  "expertId" WITH =,
  tsrange("blockedStartAt", "blockedEndAt", '[)') WITH &&
) WHERE ("status" IN ('HELD', 'CONFIRMED', 'ACKNOWLEDGED', 'IN_PROGRESS'));

-- One live hold per customer (a new hold releases the old one first, in the same transaction).
CREATE UNIQUE INDEX "call_bookings_one_hold_per_customer" ON "call_bookings" ("customerUserId") WHERE "status" = 'HELD';

-- Booking codes CALL-YYYY-NNNNNN (nextval on confirm).
CREATE SEQUENCE "call_booking_code_seq" START 1;

-- Price / quantity snapshot is frozen once the hold is confirmed; product / farm snapshots may change
-- only on the erase path (erasedAt set), which writes redaction values.
CREATE FUNCTION "call_booking_snapshot_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'HELD' THEN
    IF NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice"
      OR NEW."priceVersion" IS DISTINCT FROM OLD."priceVersion"
      OR NEW."quotedAt" IS DISTINCT FROM OLD."quotedAt"
      OR NEW."priceTrace" IS DISTINCT FROM OLD."priceTrace"
      OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
      OR NEW."quantityUnit" IS DISTINCT FROM OLD."quantityUnit" THEN
      RAISE EXCEPTION 'call booking price/quantity snapshot is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."productSnapshot" IS DISTINCT FROM OLD."productSnapshot"
        OR NEW."farmSnapshot" IS DISTINCT FROM OLD."farmSnapshot")
       AND NEW."erasedAt" IS NULL THEN
      RAISE EXCEPTION 'call booking snapshots change only on erase' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "call_bookings_snapshot_guard" BEFORE UPDATE ON "call_bookings"
  FOR EACH ROW EXECUTE FUNCTION "call_booking_snapshot_guard"();

-- Append-only tables (D-15 function from the init migration). Retention purges run as the migrator role.
CREATE TRIGGER "call_booking_events_append_only" BEFORE UPDATE OR DELETE ON "call_booking_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "call_booking_events_no_truncate" BEFORE TRUNCATE ON "call_booking_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "call_consents_append_only" BEFORE UPDATE OR DELETE ON "call_consents"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "call_consents_no_truncate" BEFORE TRUNCATE ON "call_consents"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "call_audit_log_append_only" BEFORE UPDATE OR DELETE ON "call_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "call_audit_log_no_truncate" BEFORE TRUNCATE ON "call_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- ───────────────────────── Seed: settings (every rule number is data) ─────────────────────────
INSERT INTO "call_settings" ("key", "value") VALUES
  ('slotMinutes', '{"VIDEO":30,"PHONE":30,"FARM_VISIT":60}'),
  ('bufferMinutes', '{"VIDEO":{"before":0,"after":10},"PHONE":{"before":0,"after":10},"FARM_VISIT":{"before":30,"after":60}}'),
  ('minNoticeMinutes', '120'),
  ('horizonDays', '30'),
  ('dateStripDays', '5'),
  ('holdTtlSeconds', '600'),
  ('ackSlaWorkingMinutes', '120'),
  ('businessHours', '{"days":[1,2,3,4,5,6],"startMinute":540,"endMinute":1080}'),
  ('reminderOffsetMinutes', '60'),
  ('reschedule', '{"cutoffMinutes":60,"maxCount":2,"afterFinalDays":7}'),
  ('attempts', '{"maxAttempts":3,"retryGapMinutes":5,"graceMinutes":15}'),
  ('noShowLimit', '{"maxNoShows":2,"windowDays":30,"blockDays":7}'),
  ('leadScoring', '{"sqlMin":70,"mqlMin":40,"valueBands":[[50000,40],[10000,25],[0,10]],"routingConsentPoints":10,"intentPoints":5,"maxIntentPoints":15}'),
  ('consentPolicyVersion', '"2026-11"'),
  ('retention', '{"heldDays":30,"piiMonths":12,"bookingYears":3,"consentYears":7,"auditYears":8,"attemptYears":1,"recordingDays":90}'),
  ('whatHappensNext', '["{{expert}} confirms within {{slaHours}} working hours.","A reminder reaches you {{reminderHours}} hour before the call.","The call comes through a FarmX masked number."]');

-- ───────────────────────── Seed: options (chips; admins add / edit / reorder) ─────────────────────────
INSERT INTO "call_options" ("id", "type", "code", "label", "icon", "sortOrder", "meta", "updatedAt")
SELECT gen_random_uuid(), v."type"::"CallOptionType", v."code", v."label", v."icon", v."sortOrder", v."meta"::jsonb, CURRENT_TIMESTAMP
FROM (VALUES
  ('CHANNEL', 'VIDEO', 'Video call', 'video', 1, NULL),
  ('CHANNEL', 'PHONE', 'Phone call', 'phone', 2, NULL),
  ('CHANNEL', 'FARM_VISIT', 'Farm visit', 'farm', 3, NULL),
  ('INTENT', 'COMPARE_PRODUCTS', 'Compare products', NULL, 1, '{"scoreWeight":5}'),
  ('INTENT', 'PACK_SIZE', 'Pack size for my flock', NULL, 2, '{"scoreWeight":5}'),
  ('INTENT', 'COLD_CHAIN_DELIVERY', 'Cold-chain delivery', NULL, 3, '{"scoreWeight":5}'),
  ('INTENT', 'DOSAGE_SCHEDULE', 'Dosage and schedule', NULL, 4, '{"scoreWeight":5}'),
  ('TIMEFRAME', 'THIS_WEEK', 'This week', NULL, 1, '{"scoreWeight":40}'),
  ('TIMEFRAME', 'THIS_MONTH', 'This month', NULL, 2, '{"scoreWeight":25}'),
  ('TIMEFRAME', 'THIS_YEAR', 'This year', NULL, 3, '{"scoreWeight":10}'),
  ('LANGUAGE', 'en', 'English', NULL, 1, NULL),
  ('LANGUAGE', 'hi', 'हिन्दी', NULL, 2, NULL),
  ('CANCEL_REASON', 'SCHEDULE_CONFLICT', 'Time no longer suits me', NULL, 1, NULL),
  ('CANCEL_REASON', 'NO_LONGER_NEEDED', 'No longer needed', NULL, 2, NULL),
  ('CANCEL_REASON', 'OTHER', 'Other', NULL, 3, NULL),
  ('DISPOSITION', 'INTERESTED', 'Interested', NULL, 1, NULL),
  ('DISPOSITION', 'ORDER_PLACED', 'Order placed', NULL, 2, NULL),
  ('DISPOSITION', 'FOLLOW_UP', 'Follow-up needed', NULL, 3, NULL),
  ('DISPOSITION', 'NOT_INTERESTED', 'Not interested', NULL, 4, NULL)
) AS v("type", "code", "label", "icon", "sortOrder", "meta");
