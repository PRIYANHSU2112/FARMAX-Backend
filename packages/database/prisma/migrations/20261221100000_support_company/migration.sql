-- support-service feature: company (licences / certificates + dealer / partner applications).

-- CreateEnum
CREATE TYPE "CompanyDocType" AS ENUM ('DRUG_LICENSE', 'GST', 'COI', 'FSSAI', 'ISO', 'OTHER');

-- CreateEnum
CREATE TYPE "CompanyApplicationType" AS ENUM ('DEALER', 'DISTRIBUTOR', 'PARTNER');

-- CreateEnum
CREATE TYPE "CompanyApplicationStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "company_documents" (
    "id" UUID NOT NULL,
    "type" "CompanyDocType" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "documentNo" VARCHAR(80) NOT NULL,
    "issuingAuthority" VARCHAR(160) NOT NULL,
    "expiresAt" DATE,
    "fileUrl" VARCHAR(1000) NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_applications" (
    "id" UUID NOT NULL,
    "applicantUserId" UUID NOT NULL,
    "businessName" VARCHAR(160) NOT NULL,
    "applicationType" "CompanyApplicationType" NOT NULL,
    "attachedDocs" JSONB NOT NULL DEFAULT '[]',
    "status" "CompanyApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewNotes" VARCHAR(500),
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_documents_isPublic_type_idx" ON "company_documents"("isPublic", "type");

-- CreateIndex
CREATE INDEX "company_applications_status_createdAt_idx" ON "company_applications"("status", "createdAt");

-- CreateIndex
CREATE INDEX "company_applications_applicantUserId_createdAt_idx" ON "company_applications"("applicantUserId", "createdAt");

-- One open (SUBMITTED) application per applicant and type.
CREATE UNIQUE INDEX "company_applications_one_open" ON "company_applications" ("applicantUserId", "applicationType")
  WHERE "status" = 'SUBMITTED';

-- A decided application always records who decided and when.
ALTER TABLE "company_applications" ADD CONSTRAINT "company_applications_review_chk"
  CHECK ("status" = 'SUBMITTED' OR ("reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL));
