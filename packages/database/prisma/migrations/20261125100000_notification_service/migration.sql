-- CreateEnum
CREATE TYPE "NotificationDevicePlatform" AS ENUM ('ANDROID', 'IOS', 'WEB');

-- CreateEnum
CREATE TYPE "NotificationApp" AS ENUM ('CUSTOMER', 'ADMIN', 'WAREHOUSE', 'LOGISTICS', 'VENDOR');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('ORDER', 'PAYMENT', 'REFUND', 'INVENTORY', 'ACCOUNT', 'SECURITY', 'PROMO', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'PUSH', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "NotificationAudience" AS ENUM ('USER', 'USERS', 'PERMISSION', 'APP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'SENT', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'RETRYING', 'FAILED', 'SKIPPED');
-- CreateTable
CREATE TABLE "notification_audit_log" (
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

    CONSTRAINT "notification_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_device_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "app" "NotificationApp" NOT NULL,
    "platform" "NotificationDevicePlatform" NOT NULL,
    "token" VARCHAR(512) NOT NULL,
    "deviceId" VARCHAR(100),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "dedupeKey" VARCHAR(160) NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "app" "NotificationApp" NOT NULL,
    "audienceType" "NotificationAudience" NOT NULL,
    "audience" JSONB NOT NULL DEFAULT '{}',
    "channels" "NotificationChannel"[],
    "templateKey" VARCHAR(80) NOT NULL,
    "templateVersion" INTEGER,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "data" JSONB NOT NULL DEFAULT '{}',
    "entityType" VARCHAR(30),
    "entityId" VARCHAR(64),
    "source" VARCHAR(10) NOT NULL,
    "sourceEventId" UUID,
    "createdBy" UUID,
    "reason" VARCHAR(500),
    "status" "NotificationStatus" NOT NULL DEFAULT 'SENT',
    "scheduledFor" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "fanoutCursor" VARCHAR(64),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_recipients" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "app" "NotificationApp" NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" VARCHAR(30),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lastError" VARCHAR(300),
    "provider" VARCHAR(20),
    "providerMessageId" VARCHAR(200),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId","category","channel")
);

-- CreateTable
CREATE TABLE "notification_order_projections" (
    "orderId" UUID NOT NULL,
    "orderNo" VARCHAR(40) NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_order_projections_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "locale" VARCHAR(10) NOT NULL DEFAULT 'en',
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" VARCHAR(200),
    "body" VARCHAR(4000) NOT NULL,
    "htmlBody" TEXT,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "description" VARCHAR(300),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_audit_log_targetType_targetId_createdAt_idx" ON "notification_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_device_tokens_token_key" ON "notification_device_tokens"("token");

-- CreateIndex
CREATE INDEX "notification_device_tokens_userId_app_idx" ON "notification_device_tokens"("userId", "app");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_status_scheduledFor_idx" ON "notifications"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "notifications_entityType_entityId_idx" ON "notifications"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE INDEX "notification_recipients_userId_app_createdAt_id_idx" ON "notification_recipients"("userId", "app", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_recipients_notificationId_userId_key" ON "notification_recipients"("notificationId", "userId");

-- CreateIndex
CREATE INDEX "notification_deliveries_notificationId_channel_status_idx" ON "notification_deliveries"("notificationId", "channel", "status");

-- CreateIndex
CREATE INDEX "notification_deliveries_channel_status_createdAt_idx" ON "notification_deliveries"("channel", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_recipientId_channel_key" ON "notification_deliveries"("recipientId", "channel");

-- CreateIndex
CREATE INDEX "notification_templates_key_idx" ON "notification_templates"("key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_key_channel_locale_version_key" ON "notification_templates"("key", "channel", "locale", "version");

-- AddForeignKey
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "notification_recipients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Inbox unread count: (userId, app) over unread rows only.
CREATE INDEX "notification_recipients_unread_idx" ON "notification_recipients"("userId", "app")
  WHERE "readAt" IS NULL;

-- Workers / sweep: deliveries due for (re)queueing, and stale SENDING claims (crash recovery).
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries"("nextAttemptAt")
  WHERE "status" IN ('PENDING', 'RETRYING');
CREATE INDEX "notification_deliveries_sending_idx" ON "notification_deliveries"("lockedAt")
  WHERE "status" = 'SENDING';

-- Push fan-out reads active tokens only.
CREATE INDEX "notification_device_tokens_active_idx" ON "notification_device_tokens"("userId", "app")
  WHERE "revokedAt" IS NULL;

-- One ACTIVE template version per (key, channel, locale).
CREATE UNIQUE INDEX "notification_templates_active_key" ON "notification_templates"("key", "channel", "locale")
  WHERE "isActive";

-- The audit log is append-only.
CREATE TRIGGER "notification_audit_log_append_only" BEFORE UPDATE OR DELETE ON "notification_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "notification_audit_log_no_truncate" BEFORE TRUNCATE ON "notification_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

-- Default templates (en, version 1). PUSH falls back to IN_APP when it has no own template.
INSERT INTO "notification_templates" ("id", "key", "channel", "title", "body", "variables", "description") VALUES
  (gen_random_uuid(), 'order.placed', 'IN_APP', 'Order {{orderNo}} placed',
   'We have received order {{orderNo}} for {{amount}}. Please complete payment by {{payBy}} to keep it.',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"amount","type":"money"},{"name":"payBy","type":"date"}]',
   'Buyer: order created, awaiting payment'),
  (gen_random_uuid(), 'payment.captured', 'IN_APP', 'Payment received',
   'We received {{amount}} for order {{orderNo}}. Our team will confirm your order shortly.',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"amount","type":"money"}]',
   'Buyer: payment captured'),
  (gen_random_uuid(), 'payment.captured', 'EMAIL', 'Payment received for order {{orderNo}}',
   E'Hello,\n\nWe received your payment of {{amount}} for order {{orderNo}}. Our team will confirm the order shortly.\n\nThank you for choosing FarmX.',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"amount","type":"money"}]',
   'Buyer: payment captured'),
  (gen_random_uuid(), 'payment.failed', 'IN_APP', 'Payment failed',
   'Your payment for order {{orderNo}} did not go through. You can try again before the payment window closes.',
   '[{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: payment attempt failed'),
  (gen_random_uuid(), 'order.confirmed', 'IN_APP', 'Order {{orderNo}} confirmed',
   'Your order {{orderNo}} is confirmed and is being prepared.',
   '[{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: admin confirmed the order'),
  (gen_random_uuid(), 'order.confirmed', 'EMAIL', 'Order {{orderNo}} confirmed',
   E'Hello,\n\nYour order {{orderNo}} is confirmed and is being prepared for dispatch.\n\nThank you for choosing FarmX.',
   '[{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: admin confirmed the order'),
  (gen_random_uuid(), 'order.rejected', 'IN_APP', 'Order {{orderNo}} not accepted',
   'We could not accept order {{orderNo}}. Any amount you paid will be refunded in full.',
   '[{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: admin rejected the order'),
  (gen_random_uuid(), 'order.rejected', 'EMAIL', 'Order {{orderNo}} could not be accepted',
   E'Hello,\n\nWe are sorry, we could not accept order {{orderNo}}. Any amount you paid will be refunded in full to the original payment method.\n\nFarmX',
   '[{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: admin rejected the order'),
  (gen_random_uuid(), 'order.rejected', 'SMS', NULL,
   'FarmX: Order {{orderNo}} could not be accepted. Any amount paid will be refunded in full.',
   '[{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: admin rejected the order'),
  (gen_random_uuid(), 'order.failed', 'IN_APP', 'Order {{orderNo}} closed',
   'Order {{orderNo}} was closed: {{reason}}. Any amount you paid will be refunded.',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"reason","type":"string","maxLength":120}]',
   'Buyer: system closed the order'),
  (gen_random_uuid(), 'order.failed', 'EMAIL', 'Order {{orderNo}} closed',
   E'Hello,\n\nOrder {{orderNo}} was closed: {{reason}}. Any amount you paid will be refunded to the original payment method.\n\nFarmX',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"reason","type":"string","maxLength":120}]',
   'Buyer: system closed the order'),
  (gen_random_uuid(), 'order.failed', 'SMS', NULL,
   'FarmX: Order {{orderNo}} was closed: {{reason}}. Any amount paid will be refunded.',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"reason","type":"string","maxLength":120}]',
   'Buyer: system closed the order'),
  (gen_random_uuid(), 'order.cancelled', 'IN_APP', 'Order {{orderNo}} cancelled',
   'Order {{orderNo}} has been cancelled. Any amount you paid will be refunded.',
   '[{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: whole order cancelled'),
  (gen_random_uuid(), 'order.cancelled', 'EMAIL', 'Order {{orderNo}} cancelled',
   E'Hello,\n\nOrder {{orderNo}} has been cancelled. Any amount you paid will be refunded to the original payment method.\n\nFarmX',
   '[{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: whole order cancelled'),
  (gen_random_uuid(), 'order.partially_cancelled', 'IN_APP', 'Items cancelled from order {{orderNo}}',
   'Some items in order {{orderNo}} were cancelled. The amount for those items will be refunded.',
   '[{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: some items cancelled'),
  (gen_random_uuid(), 'order.partially_cancelled', 'EMAIL', 'Items cancelled from order {{orderNo}}',
   E'Hello,\n\nSome items in order {{orderNo}} were cancelled. The amount for those items will be refunded to the original payment method.\n\nFarmX',
   '[{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: some items cancelled'),
  (gen_random_uuid(), 'refund.initiated', 'IN_APP', 'Refund started',
   'A refund of {{amount}} for order {{orderNo}} has started. Expected by {{expectedBy}}.',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"amount","type":"money"},{"name":"expectedBy","type":"date"}]',
   'Buyer: gateway accepted the refund'),
  (gen_random_uuid(), 'refund.initiated', 'EMAIL', 'Refund started for order {{orderNo}}',
   E'Hello,\n\nA refund of {{amount}} for order {{orderNo}} has started. It should reach your account by {{expectedBy}}.\n\nFarmX',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"amount","type":"money"},{"name":"expectedBy","type":"date"}]',
   'Buyer: gateway accepted the refund'),
  (gen_random_uuid(), 'refund.processed', 'IN_APP', 'Refund completed',
   '{{amount}} for order {{orderNo}} has been refunded to your original payment method.',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"amount","type":"money"}]',
   'Buyer: refund completed'),
  (gen_random_uuid(), 'refund.processed', 'EMAIL', 'Refund completed for order {{orderNo}}',
   E'Hello,\n\n{{amount}} for order {{orderNo}} has been refunded to your original payment method.\n\nFarmX',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"amount","type":"money"}]',
   'Buyer: refund completed'),
  (gen_random_uuid(), 'refund.failed', 'IN_APP', 'Refund needs attention',
   'The refund of {{amount}} for order {{orderNo}} failed ({{reason}}). Review it in Refunds.',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"amount","type":"money"},{"name":"reason","type":"string","maxLength":120}]',
   'Staff: refund retries exhausted or refused'),
  (gen_random_uuid(), 'order.review_overdue', 'IN_APP', 'Order waiting for review',
   'Order {{orderNo}} has waited {{waitingMinutes}} minutes for confirmation.',
   '[{"name":"orderNo","type":"string","maxLength":40},{"name":"waitingMinutes","type":"number"}]',
   'Staff: paid order passed the review SLA'),
  (gen_random_uuid(), 'inventory.low_stock', 'IN_APP', 'Low stock',
   'A product reached its reorder level: {{availableQty}} left (threshold {{threshold}}).',
   '[{"name":"availableQty","type":"number"},{"name":"threshold","type":"number"}]',
   'Warehouse: a variant crossed down to its reorder level'),
  (gen_random_uuid(), 'admin.message', 'IN_APP', '{{title}}', '{{body}}',
   '[{"name":"title","type":"string","maxLength":120},{"name":"body","type":"string","maxLength":800}]',
   'Admin: free-text message'),
  (gen_random_uuid(), 'admin.message', 'EMAIL', '{{title}}', E'{{body}}\n\nFarmX',
   '[{"name":"title","type":"string","maxLength":120},{"name":"body","type":"string","maxLength":800}]',
   'Admin: free-text message'),
  (gen_random_uuid(), 'admin.message', 'SMS', NULL, 'FarmX: {{body}}',
   '[{"name":"title","type":"string","maxLength":120},{"name":"body","type":"string","maxLength":300}]',
   'Admin: free-text message');
