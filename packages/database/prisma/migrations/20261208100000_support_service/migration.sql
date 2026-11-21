-- CreateEnum
CREATE TYPE "LegalDocKind" AS ENUM ('PRIVACY_POLICY', 'TERMS', 'REFUND_POLICY', 'SHIPPING_POLICY');

-- CreateEnum
CREATE TYPE "LegalDocStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SupportApp" AS ENUM ('CUSTOMER', 'VENDOR', 'LOGISTICS', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('NEW', 'OPEN', 'WAITING_ON_REQUESTER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportChannel" AS ENUM ('APP', 'CHAT', 'PHONE', 'EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "SupportSenderRole" AS ENUM ('REQUESTER', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SupportMessageKind" AS ENUM ('TEXT', 'SYSTEM', 'ESCALATION', 'ACTION_CARD', 'INTERNAL_NOTE');

-- CreateEnum
CREATE TYPE "SupportVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateEnum
CREATE TYPE "SupportCsat" AS ENUM ('YES', 'NOT_YET');

-- CreateEnum
CREATE TYPE "SupportPriority" AS ENUM ('URGENT', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "SupportTeam" AS ENUM ('SUPPORT', 'VET', 'LOGISTICS', 'FINANCE', 'QUALITY', 'WAREHOUSE');

-- CreateTable
CREATE TABLE "support_agents" (
    "userId" UUID NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "teams" "SupportTeam"[],
    "apps" "SupportApp"[],
    "maxConcurrent" INTEGER NOT NULL DEFAULT 8,
    "acceptingChats" BOOLEAN NOT NULL DEFAULT false,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_agents_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "support_canned_replies" (
    "id" UUID NOT NULL,
    "app" "SupportApp",
    "topicCode" VARCHAR(40),
    "title" VARCHAR(80) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_canned_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_audit_log" (
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

    CONSTRAINT "support_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_categories" (
    "id" UUID NOT NULL,
    "app" "SupportApp" NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faq_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faqs" (
    "id" UUID NOT NULL,
    "app" "SupportApp" NOT NULL,
    "categoryId" UUID NOT NULL,
    "question" VARCHAR(300) NOT NULL,
    "answer" VARCHAR(4000) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topicCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "helpfulCount" INTEGER NOT NULL DEFAULT 0,
    "notHelpfulCount" INTEGER NOT NULL DEFAULT 0,
    "searchVector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english'::regconfig, "question"), 'A') ||
        setweight(to_tsvector('english'::regconfig, "answer"), 'B')
    ) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_votes" (
    "faqId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faq_votes_pkey" PRIMARY KEY ("faqId","userId")
);

-- CreateTable
CREATE TABLE "legal_documents" (
    "id" UUID NOT NULL,
    "kind" "LegalDocKind" NOT NULL,
    "app" "SupportApp",
    "version" INTEGER NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "intro" VARCHAR(2000),
    "sections" JSONB NOT NULL,
    "status" "LegalDocStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedBy" UUID,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_settings" (
    "key" VARCHAR(60) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "support_calendars" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "timezone" VARCHAR(40) NOT NULL,
    "weeklyHours" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_holidays" (
    "id" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "ticketNo" VARCHAR(20) NOT NULL,
    "app" "SupportApp" NOT NULL,
    "requesterId" UUID NOT NULL,
    "requesterType" VARCHAR(20) NOT NULL,
    "requesterName" VARCHAR(120),
    "farmId" UUID,
    "topicId" UUID NOT NULL,
    "topicCode" VARCHAR(40) NOT NULL,
    "topicLabel" VARCHAR(80) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "priority" "SupportPriority" NOT NULL,
    "priorityReason" VARCHAR(80),
    "priorityLocked" BOOLEAN NOT NULL DEFAULT false,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'NEW',
    "team" "SupportTeam" NOT NULL,
    "assigneeId" UUID,
    "assigneeName" VARCHAR(120),
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "channel" "SupportChannel" NOT NULL DEFAULT 'APP',
    "orderId" UUID,
    "orderContext" JSONB,
    "callbackRequested" BOOLEAN NOT NULL DEFAULT false,
    "callbackPhone" VARCHAR(20),
    "slaPolicy" JSONB NOT NULL,
    "slaStartedAt" TIMESTAMP(3) NOT NULL,
    "firstResponseDueAt" TIMESTAMP(3) NOT NULL,
    "firstRespondedAt" TIMESTAMP(3),
    "firstResponseBreachedAt" TIMESTAMP(3),
    "resolveDueAt" TIMESTAMP(3) NOT NULL,
    "resolveBreachedAt" TIMESTAMP(3),
    "slaPausedAt" TIMESTAMP(3),
    "pausedBizMins" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "csat" "SupportCsat",
    "csatComment" VARCHAR(500),
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "lastPublicSeq" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessagePreview" VARCHAR(140),
    "lastSenderRole" "SupportSenderRole",
    "version" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" VARCHAR(64),
    "requesterScrubbedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_messages" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "senderId" UUID,
    "senderRole" "SupportSenderRole" NOT NULL,
    "senderName" VARCHAR(120),
    "kind" "SupportMessageKind" NOT NULL DEFAULT 'TEXT',
    "visibility" "SupportVisibility" NOT NULL DEFAULT 'PUBLIC',
    "body" VARCHAR(4000) NOT NULL,
    "attachmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "card" JSONB,
    "clientMessageId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_participants" (
    "ticketId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" VARCHAR(12) NOT NULL,
    "lastReadSeq" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_participants_pkey" PRIMARY KEY ("ticketId","userId")
);

-- CreateTable
CREATE TABLE "support_ticket_events" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "from" VARCHAR(60),
    "to" VARCHAR(60),
    "actorId" UUID,
    "reason" VARCHAR(500),
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_attachments" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "messageId" UUID,
    "uploaderId" UUID NOT NULL,
    "mediaKey" VARCHAR(300) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "mime" VARCHAR(80) NOT NULL,
    "size" INTEGER NOT NULL,
    "fileName" VARCHAR(160),
    "scanStatus" VARCHAR(20) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_topics" (
    "id" UUID NOT NULL,
    "app" "SupportApp" NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "description" VARCHAR(200),
    "icon" VARCHAR(40),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "defaultPriority" "SupportPriority" NOT NULL DEFAULT 'MEDIUM',
    "team" "SupportTeam" NOT NULL DEFAULT 'SUPPORT',
    "requiresOrder" BOOLEAN NOT NULL DEFAULT false,
    "allowsEvidence" BOOLEAN NOT NULL DEFAULT true,
    "isCommonIssue" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_priority_rules" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "app" "SupportApp",
    "topicCode" VARCHAR(40),
    "conditions" JSONB NOT NULL,
    "priority" "SupportPriority" NOT NULL,
    "reasonLabel" VARCHAR(40) NOT NULL,
    "team" "SupportTeam",
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_priority_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_sla_policies" (
    "id" UUID NOT NULL,
    "app" "SupportApp" NOT NULL,
    "priority" "SupportPriority" NOT NULL,
    "calendarId" UUID,
    "firstResponseMins" INTEGER NOT NULL,
    "resolveMins" INTEGER NOT NULL,
    "businessHoursOnly" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_agents_isActive_acceptingChats_openCount_idx" ON "support_agents"("isActive", "acceptingChats", "openCount");

-- CreateIndex
CREATE INDEX "support_canned_replies_isActive_app_idx" ON "support_canned_replies"("isActive", "app");

-- CreateIndex
CREATE INDEX "support_audit_log_targetType_targetId_createdAt_idx" ON "support_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "support_audit_log_actorUserId_createdAt_idx" ON "support_audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "faq_categories_app_code_key" ON "faq_categories"("app", "code");

-- CreateIndex
CREATE INDEX "faqs_app_isActive_categoryId_sortOrder_idx" ON "faqs"("app", "isActive", "categoryId", "sortOrder");

-- CreateIndex
CREATE INDEX "legal_documents_kind_app_status_idx" ON "legal_documents"("kind", "app", "status");

-- CreateIndex
CREATE UNIQUE INDEX "support_calendars_name_key" ON "support_calendars"("name");

-- CreateIndex
CREATE UNIQUE INDEX "support_holidays_calendarId_date_key" ON "support_holidays"("calendarId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_ticketNo_key" ON "support_tickets"("ticketNo");

-- CreateIndex
CREATE INDEX "support_tickets_requesterId_status_lastMessageAt_idx" ON "support_tickets"("requesterId", "status", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "support_tickets_assigneeId_status_idx" ON "support_tickets"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "support_tickets_status_priority_resolveDueAt_idx" ON "support_tickets"("status", "priority", "resolveDueAt");

-- CreateIndex
CREATE INDEX "support_tickets_orderId_idx" ON "support_tickets"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_requesterId_idempotencyKey_key" ON "support_tickets"("requesterId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_messages_ticketId_seq_key" ON "support_ticket_messages"("ticketId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_messages_ticketId_senderId_clientMessageId_key" ON "support_ticket_messages"("ticketId", "senderId", "clientMessageId");

-- CreateIndex
CREATE INDEX "support_ticket_participants_userId_idx" ON "support_ticket_participants"("userId");

-- CreateIndex
CREATE INDEX "support_ticket_events_ticketId_createdAt_idx" ON "support_ticket_events"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "support_attachments_mediaKey_key" ON "support_attachments"("mediaKey");

-- CreateIndex
CREATE INDEX "support_attachments_ticketId_idx" ON "support_attachments"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "support_topics_app_code_key" ON "support_topics"("app", "code");

-- CreateIndex
CREATE INDEX "support_priority_rules_isActive_sortOrder_idx" ON "support_priority_rules"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "support_sla_policies_app_priority_key" ON "support_sla_policies"("app", "priority");


-- ── support-service raw SQL (not expressible in Prisma) ──

-- Ticket numbers: TK-<year>-<6 digits> from one sequence (no hot counter row, no collisions).
CREATE SEQUENCE "support_ticket_no_seq" START 1;

-- FAQ full-text search (english; question A, answer B).
CREATE INDEX "faqs_search_vector_idx" ON "faqs" USING GIN ("searchVector");

-- Active-queue index: the admin queue only ever scans open tickets.
CREATE INDEX "support_tickets_active_queue_idx" ON "support_tickets" ("priority", "resolveDueAt")
  WHERE "status" IN ('NEW', 'OPEN', 'WAITING_ON_REQUESTER');
-- SLA sweeper: open tickets whose clocks have not breached yet.
CREATE INDEX "support_tickets_first_response_due_idx" ON "support_tickets" ("firstResponseDueAt")
  WHERE "firstRespondedAt" IS NULL AND "firstResponseBreachedAt" IS NULL AND "status" IN ('NEW', 'OPEN', 'WAITING_ON_REQUESTER');
CREATE INDEX "support_tickets_resolve_due_idx" ON "support_tickets" ("resolveDueAt")
  WHERE "resolveBreachedAt" IS NULL AND "slaPausedAt" IS NULL AND "status" IN ('NEW', 'OPEN');
-- Auto-close sweeper.
CREATE INDEX "support_tickets_resolved_at_idx" ON "support_tickets" ("resolvedAt") WHERE "status" = 'RESOLVED';

-- Legal: one PUBLISHED version per (kind, app|ALL); versions unique per (kind, app|ALL).
CREATE UNIQUE INDEX "legal_documents_one_published_app" ON "legal_documents" ("kind", "app")
  WHERE "status" = 'PUBLISHED' AND "app" IS NOT NULL;
CREATE UNIQUE INDEX "legal_documents_one_published_all" ON "legal_documents" ("kind")
  WHERE "status" = 'PUBLISHED' AND "app" IS NULL;
CREATE UNIQUE INDEX "legal_documents_version_app_key" ON "legal_documents" ("kind", "app", "version") WHERE "app" IS NOT NULL;
CREATE UNIQUE INDEX "legal_documents_version_all_key" ON "legal_documents" ("kind", "version") WHERE "app" IS NULL;

-- Sanity checks.
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_counts_chk"
  CHECK ("lastSeq" >= 0 AND "version" >= 0 AND "reopenCount" >= 0 AND "escalationLevel" >= 0 AND "pausedBizMins" >= 0);
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_seq_chk" CHECK ("seq" >= 1);
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_internal_chk"
  CHECK (("kind" = 'INTERNAL_NOTE') = ("visibility" = 'INTERNAL'));
ALTER TABLE "support_agents" ADD CONSTRAINT "support_agents_load_chk"
  CHECK ("openCount" >= 0 AND "maxConcurrent" BETWEEN 1 AND 100);
ALTER TABLE "support_sla_policies" ADD CONSTRAINT "support_sla_policies_mins_chk"
  CHECK ("firstResponseMins" BETWEEN 1 AND 43200 AND "resolveMins" BETWEEN 1 AND 129600 AND "firstResponseMins" <= "resolveMins");
ALTER TABLE "faqs" ADD CONSTRAINT "faqs_counts_chk" CHECK ("helpfulCount" >= 0 AND "notHelpfulCount" >= 0);
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_size_chk" CHECK ("size" > 0);

-- History and audit are append-only (same trigger function as the other audit tables).
CREATE TRIGGER "support_ticket_events_append_only" BEFORE UPDATE OR DELETE ON "support_ticket_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "support_ticket_events_no_truncate" BEFORE TRUNCATE ON "support_ticket_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "support_audit_log_append_only" BEFORE UPDATE OR DELETE ON "support_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "support_audit_log_no_truncate" BEFORE TRUNCATE ON "support_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
ALTER TABLE "support_sla_policies" ADD CONSTRAINT "support_sla_policies_calendar_chk" CHECK (NOT "businessHoursOnly" OR "calendarId" IS NOT NULL);
