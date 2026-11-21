-- CreateEnum
CREATE TYPE "ContentKind" AS ENUM ('NEWS', 'ALERT', 'GUIDE', 'VIDEO', 'CHECKLIST', 'ANNOUNCEMENT');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'SCHEDULED', 'PUBLISHED', 'EXPIRED', 'RETRACTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ContentRevisionStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED');

-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE 'CONTENT';

-- AlterEnum
ALTER TYPE "NotificationAudience" ADD VALUE 'FARM_CONTENT';

-- CreateTable
CREATE TABLE "content_topics" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "clinical" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_reviewers" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "displayName" VARCHAR(100) NOT NULL,
    "qualification" VARCHAR(60) NOT NULL,
    "registrationNo" VARCHAR(40) NOT NULL,
    "verifiedByUserId" UUID NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_reviewers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "kind" "ContentKind" NOT NULL,
    "topicId" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "summary" VARCHAR(400) NOT NULL,
    "heroImageUrl" VARCHAR(500),
    "heroMediaId" UUID,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "bodyText" TEXT NOT NULL DEFAULT '',
    "searchVector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english'::regconfig, "title"), 'A') ||
        setweight(to_tsvector('english'::regconfig, "summary"), 'B') ||
        setweight(to_tsvector('english'::regconfig, "bodyText"), 'D')
    ) STORED,
    "readMinutes" SMALLINT NOT NULL DEFAULT 1,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "assetUrl" VARCHAR(500),
    "assetMediaId" UUID,
    "assetKind" VARCHAR(10),
    "assetSizeBytes" INTEGER,
    "durationSec" INTEGER,
    "pageCount" SMALLINT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "relatedIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "ctas" JSONB NOT NULL DEFAULT '[]',
    "productionTypes" "ProductionType"[] DEFAULT ARRAY[]::"ProductionType"[],
    "territoryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "severity" "AlertSeverity",
    "placeLabel" VARCHAR(80),
    "areaLat" DECIMAL(5,2),
    "areaLng" DECIMAL(5,2),
    "clinicalReviewerId" UUID,
    "clinicalSignedOffAt" TIMESTAMP(3),
    "signedOffHash" CHAR(64),
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "notify" BOOLEAN NOT NULL DEFAULT false,
    "publishAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "retractedAt" TIMESTAMP(3),
    "retractNote" VARCHAR(300),
    "notifiedAt" TIMESTAMP(3),
    "lastCorrectedAt" TIMESTAMP(3),
    "correctionNote" VARCHAR(300),
    "contentVersion" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "helpfulYes" INTEGER NOT NULL DEFAULT 0,
    "helpfulNo" INTEGER NOT NULL DEFAULT 0,
    "saveCount" INTEGER NOT NULL DEFAULT 0,
    "shareCount" INTEGER NOT NULL DEFAULT 0,
    "trendingScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "submittedByUserId" UUID,
    "submittedAt" TIMESTAMP(3),
    "publishedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_revisions" (
    "id" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "changeNote" VARCHAR(300) NOT NULL,
    "status" "ContentRevisionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByUserId" UUID NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signedOffById" UUID,
    "signedOffAt" TIMESTAMP(3),
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMP(3),
    "rejectReason" VARCHAR(500),

    CONSTRAINT "content_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_status_events" (
    "id" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "from" "ContentStatus",
    "to" "ContentStatus" NOT NULL,
    "actorUserId" UUID,
    "reason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_saves" (
    "userId" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "downloadedVersion" INTEGER,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_saves_pkey" PRIMARY KEY ("userId","contentId")
);

-- CreateTable
CREATE TABLE "content_feedback" (
    "userId" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_feedback_pkey" PRIMARY KEY ("userId","contentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_topics_code_key" ON "content_topics"("code");

-- CreateIndex
CREATE INDEX "content_topics_isActive_sortOrder_idx" ON "content_topics"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "content_reviewers_userId_key" ON "content_reviewers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "content_items_slug_key" ON "content_items"("slug");

-- CreateIndex
CREATE INDEX "content_items_status_publishedAt_id_idx" ON "content_items"("status", "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "content_items_topicId_status_publishedAt_idx" ON "content_items"("topicId", "status", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "content_items_status_trendingScore_idx" ON "content_items"("status", "trendingScore" DESC);

-- CreateIndex
CREATE INDEX "content_items_status_expiresAt_idx" ON "content_items"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "content_items_status_publishAt_idx" ON "content_items"("status", "publishAt");

-- CreateIndex
CREATE INDEX "content_items_updatedAt_idx" ON "content_items"("updatedAt");

-- CreateIndex
CREATE INDEX "content_items_territoryCodes_idx" ON "content_items" USING GIN ("territoryCodes");

-- CreateIndex
CREATE INDEX "content_items_productionTypes_idx" ON "content_items" USING GIN ("productionTypes");

-- CreateIndex
CREATE INDEX "content_items_tags_idx" ON "content_items" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "content_revisions_contentId_requestedAt_idx" ON "content_revisions"("contentId", "requestedAt");

-- CreateIndex
CREATE INDEX "content_revisions_status_requestedAt_idx" ON "content_revisions"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "content_status_events_contentId_createdAt_idx" ON "content_status_events"("contentId", "createdAt");

-- CreateIndex
CREATE INDEX "content_saves_userId_savedAt_idx" ON "content_saves"("userId", "savedAt" DESC);

-- CreateIndex
CREATE INDEX "content_saves_contentId_idx" ON "content_saves"("contentId");

-- CreateIndex
CREATE INDEX "content_feedback_contentId_idx" ON "content_feedback"("contentId");

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "content_topics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_clinicalReviewerId_fkey" FOREIGN KEY ("clinicalReviewerId") REFERENCES "content_reviewers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_status_events" ADD CONSTRAINT "content_status_events_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "content_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Raw SQL (not expressible in Prisma) ──────────────────────────────────────────────────────

-- Full-text search over live content (english config; title A, summary B, tags + body D).
CREATE INDEX "content_items_search_vector_idx" ON "content_items" USING GIN ("searchVector");

-- Transitions are append-only (same trigger function as the other audit tables).
CREATE TRIGGER "content_status_events_append_only" BEFORE UPDATE OR DELETE ON "content_status_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "content_status_events_no_truncate" BEFORE TRUNCATE ON "content_status_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- At most one PENDING revision per item (a second request must wait for the decision).
CREATE UNIQUE INDEX "content_revisions_one_pending" ON "content_revisions"("contentId")
  WHERE "status" = 'PENDING';

-- Default topic chips (system user = nil uuid; admins edit them later).
INSERT INTO "content_topics" ("id", "code", "name", "clinical", "sortOrder", "createdByUserId", "updatedByUserId", "updatedAt") VALUES
  (gen_random_uuid(), 'DISEASE',      'Disease',      true,  10, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'KNOWLEDGE',    'Knowledge',    true,  20, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'REGULATION',   'Regulation',   false, 30, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'WEATHER',      'Weather',      false, 40, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'ANNOUNCEMENT', 'FarmX news',   false, 50, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', CURRENT_TIMESTAMP);

-- notification-service templates for content events (en, version 1; PUSH falls back to IN_APP).
INSERT INTO "notification_templates" ("id", "key", "channel", "title", "body", "variables", "description") VALUES
  (gen_random_uuid(), 'content.alert', 'IN_APP', '{{title}}',
   '{{summary}}',
   '[{"name":"title","type":"string","maxLength":160},{"name":"summary","type":"string","maxLength":400}]',
   'Customer: disease alert published'),
  (gen_random_uuid(), 'content.news', 'IN_APP', '{{title}}', '{{summary}}',
   '[{"name":"title","type":"string","maxLength":160},{"name":"summary","type":"string","maxLength":400}]',
   'Customer: news / knowledge item published'),
  (gen_random_uuid(), 'content.corrected', 'IN_APP', 'Updated: {{title}}', '{{note}}',
   '[{"name":"title","type":"string","maxLength":160},{"name":"note","type":"string","maxLength":300}]',
   'Customer: a published item was corrected'),
  (gen_random_uuid(), 'content.retracted', 'IN_APP', 'Withdrawn: {{title}}', '{{note}}',
   '[{"name":"title","type":"string","maxLength":160},{"name":"note","type":"string","maxLength":300}]',
   'Customer: a published item was withdrawn as incorrect');
