-- auth-service feature: deletion (self-service account deletion with a 30-day grace period).

-- CreateEnum
CREATE TYPE "AccountDeletionStatus" AS ENUM ('PENDING', 'CANCELLED', 'COMPLETED');

-- AlterEnum (not used in this migration, so it is safe inside the transaction on PG 12+)
ALTER TYPE "UserStatus" ADD VALUE 'PENDING_DELETION';

-- CreateTable
CREATE TABLE "account_deletion_requests" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" VARCHAR(500),
    "status" "AccountDeletionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_deletion_requests_status_scheduledFor_idx" ON "account_deletion_requests"("status", "scheduledFor");
CREATE INDEX "account_deletion_requests_userId_idx" ON "account_deletion_requests"("userId");

-- One PENDING request per user (a double tap or two devices cannot create two).
CREATE UNIQUE INDEX "account_deletion_requests_one_pending" ON "account_deletion_requests"("userId") WHERE "status" = 'PENDING';
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_dates_chk" CHECK ("scheduledFor" > "requestedAt");
