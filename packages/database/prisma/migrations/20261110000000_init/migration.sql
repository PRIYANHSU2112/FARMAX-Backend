-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('GLOBAL', 'WAREHOUSE', 'REGION', 'VENDOR', 'OWN');

-- CreateEnum
CREATE TYPE "RoleAudience" AS ENUM ('INTERNAL', 'CUSTOMER', 'VENDOR', 'LOGISTICS_PARTNER');

-- CreateEnum
CREATE TYPE "MfaFactorType" AS ENUM ('TOTP', 'SMS_OTP');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('UNVERIFIED', 'TRUSTED', 'BLOCKED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS', 'WEB', 'DESKTOP', 'OTHER');

-- CreateEnum
CREATE TYPE "AuthEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT', 'LOGOUT_ALL', 'OTP_SENT', 'OTP_VERIFIED', 'OTP_FAILED', 'OTP_RATE_LIMITED', 'TOKEN_REFRESHED', 'TOKEN_REUSE_DETECTED', 'SESSION_REVOKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET', 'MFA_ENROLLED', 'MFA_REMOVED', 'MFA_SUCCESS', 'MFA_FAILED', 'ACCOUNT_LOCKED', 'ACCOUNT_UNLOCKED', 'STATUS_CHANGED', 'NEW_DEVICE', 'DEVICE_TRUSTED', 'DEVICE_BLOCKED', 'DEVICE_UNBLOCKED', 'DEVICE_REVOKED', 'DEVICE_LOGIN_BLOCKED');

-- CreateEnum
CREATE TYPE "SessionRevokeReason" AS ENUM ('LOGOUT', 'LOGOUT_ALL', 'REUSE_DETECTED', 'PASSWORD_CHANGED', 'ROLE_CHANGED', 'USER_SUSPENDED', 'DEVICE_BLOCKED', 'DEVICE_REVOKED', 'IDLE_TIMEOUT', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('INTERNAL', 'CUSTOMER', 'VENDOR', 'LOGISTICS_PARTNER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'LOCKED', 'SUSPENDED', 'DEACTIVATED');

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "audience" "RoleAudience" NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "mfaRequired" BOOLEAN NOT NULL DEFAULT true,
    "sessionIdleMinutes" INTEGER,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isSensitive" BOOLEAN NOT NULL DEFAULT false,
    "assignable" BOOLEAN NOT NULL DEFAULT true,
    "allowedScopes" "ScopeType"[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deprecatedAt" TIMESTAMP(3),

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "grantedByUserId" UUID,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "scopeType" "ScopeType" NOT NULL DEFAULT 'GLOBAL',
    "scopeId" UUID,
    "assignedByUserId" UUID,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,
    "reason" TEXT,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "subjectUserId" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "userId" UUID NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "passwordExpiresAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "password_history" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "MfaFactorType" NOT NULL,
    "label" TEXT,
    "secretEncrypted" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "platform" "DevicePlatform" NOT NULL DEFAULT 'OTHER',
    "name" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "osName" TEXT,
    "osVersion" TEXT,
    "browserName" TEXT,
    "browserVersion" TEXT,
    "appVersion" TEXT,
    "pushToken" TEXT,
    "firstIp" TEXT,
    "lastIp" TEXT,
    "lastCountry" TEXT,
    "lastRegion" TEXT,
    "lastCity" TEXT,
    "lastLatitude" DECIMAL(9,6),
    "lastLongitude" DECIMAL(9,6),
    "riskFlags" JSONB,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "loginCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),
    "trustedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "blockedByUserId" UUID,
    "blockedReason" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_events" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "identifier" TEXT,
    "type" "AuthEventType" NOT NULL,
    "success" BOOLEAN NOT NULL,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "deviceId" UUID,
    "sessionId" UUID,
    "country" TEXT,
    "city" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "riskScore" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "eventId" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("eventId","consumer")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID,
    "familyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "replacedById" UUID,
    "rotatedAt" TIMESTAMP(3),
    "mfaVerifiedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" "SessionRevokeReason",

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "userType" "UserType" NOT NULL,
    "email" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "phone" TEXT,
    "phoneVerifiedAt" TIMESTAMP(3),
    "username" TEXT,
    "fullName" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "employeeCode" TEXT,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "statusReason" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "mfaRequired" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "parentUserId" UUID,
    "delegateOrderLimit" DECIMAL(14,2),
    "createdByUserId" UUID,
    "registrationSource" TEXT,
    "termsAcceptedAt" TIMESTAMP(3),
    "privacyConsentAt" TIMESTAMP(3),
    "marketingConsentAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "lastLoginDeviceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE INDEX "roles_audience_archivedAt_idx" ON "roles"("audience", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "permissions_module_sortOrder_idx" ON "permissions"("module", "sortOrder");

-- CreateIndex
CREATE INDEX "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");

-- CreateIndex
CREATE INDEX "user_roles_userId_revokedAt_idx" ON "user_roles"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

-- CreateIndex
CREATE INDEX "user_roles_scopeType_scopeId_idx" ON "user_roles"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "admin_audit_log_subjectUserId_createdAt_idx" ON "admin_audit_log"("subjectUserId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_actorUserId_createdAt_idx" ON "admin_audit_log"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_targetType_targetId_createdAt_idx" ON "admin_audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_action_createdAt_idx" ON "admin_audit_log"("action", "createdAt");

-- CreateIndex
CREATE INDEX "password_history_userId_createdAt_idx" ON "password_history"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "mfa_factors_userId_idx" ON "mfa_factors"("userId");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_userId_idx" ON "mfa_recovery_codes"("userId");

-- CreateIndex
CREATE INDEX "user_devices_userId_lastSeenAt_idx" ON "user_devices"("userId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "user_devices_status_idx" ON "user_devices"("status");

-- CreateIndex
CREATE INDEX "user_devices_deviceHash_idx" ON "user_devices"("deviceHash");

-- CreateIndex
CREATE UNIQUE INDEX "user_devices_userId_deviceHash_key" ON "user_devices"("userId", "deviceHash");

-- CreateIndex
CREATE INDEX "auth_events_userId_createdAt_idx" ON "auth_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "auth_events_deviceId_createdAt_idx" ON "auth_events"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "auth_events_type_createdAt_idx" ON "auth_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "auth_events_ip_createdAt_idx" ON "auth_events"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_createdAt_idx" ON "outbox_events"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "processed_events_processedAt_idx" ON "processed_events"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_deviceId_idx" ON "sessions"("deviceId");

-- CreateIndex
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");

-- CreateIndex
CREATE INDEX "sessions_absoluteExpiresAt_idx" ON "sessions"("absoluteExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_employeeCode_key" ON "users"("employeeCode");

-- CreateIndex
CREATE INDEX "users_userType_status_createdAt_idx" ON "users"("userType", "status", "createdAt");

-- CreateIndex
CREATE INDEX "users_parentUserId_idx" ON "users"("parentUserId");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_parentUserId_fkey" FOREIGN KEY ("parentUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Hand-written: constraints and protections Prisma cannot express.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- users: every account needs at least one login identifier (email or phone).
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_or_phone_chk" CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL),
  ADD CONSTRAINT "users_email_lowercase_chk" CHECK ("email" IS NULL OR "email" = lower("email")),
  ADD CONSTRAINT "users_username_lowercase_chk" CHECK ("username" IS NULL OR "username" = lower("username")),
  ADD CONSTRAINT "users_phone_e164_chk" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "users_no_self_parent_chk" CHECK ("parentUserId" IS NULL OR "parentUserId" <> "id");

-- users: fast list screens over live (not soft-deleted) users.
CREATE INDEX "users_live_created_idx" ON "users" ("id" DESC) WHERE "deletedAt" IS NULL;

-- user_devices: risk score is a 0–100 scale.
ALTER TABLE "user_devices"
  ADD CONSTRAINT "user_devices_risk_score_chk" CHECK ("riskScore" BETWEEN 0 AND 100);

-- roles: stable snake_case key; sane idle timeout.
ALTER TABLE "roles"
  ADD CONSTRAINT "roles_key_format_chk" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,62}$'),
  ADD CONSTRAINT "roles_idle_minutes_chk" CHECK ("sessionIdleMinutes" IS NULL OR "sessionIdleMinutes" BETWEEN 1 AND 43200);

-- permissions: <module>.<action> format.
ALTER TABLE "permissions"
  ADD CONSTRAINT "permissions_key_format_chk" CHECK ("key" ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$');

-- user_roles: scopeId is required for WAREHOUSE/REGION/VENDOR and forbidden for GLOBAL/OWN.
ALTER TABLE "user_roles"
  ADD CONSTRAINT "user_roles_scope_id_chk" CHECK (
    ("scopeType" IN ('GLOBAL', 'OWN') AND "scopeId" IS NULL)
    OR ("scopeType" IN ('WAREHOUSE', 'REGION', 'VENDOR') AND "scopeId" IS NOT NULL)
  ),
  ADD CONSTRAINT "user_roles_revoked_by_chk" CHECK ("revokedAt" IS NULL OR "revokedByUserId" IS NOT NULL);

-- user_roles: at most one ACTIVE assignment per (user, role, scope). Revoked rows are history.
CREATE UNIQUE INDEX "user_roles_active_unique"
  ON "user_roles" ("userId", "roleId", "scopeType", COALESCE("scopeId", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "revokedAt" IS NULL;

-- sessions: fast lookup of live sessions per user and idle-expiry sweeps.
CREATE INDEX "sessions_live_by_user_idx" ON "sessions" ("userId") WHERE "revokedAt" IS NULL;

-- admin_audit_log: <target>.<verb> action names.
ALTER TABLE "admin_audit_log"
  ADD CONSTRAINT "admin_audit_log_action_format_chk" CHECK ("action" ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$');

-- roles.key is immutable once created (permissions and code reference it).
CREATE FUNCTION "forbid_role_key_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."key" <> OLD."key" THEN
    RAISE EXCEPTION 'roles.key is immutable (% -> %)', OLD."key", NEW."key" USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "roles_key_immutable" BEFORE UPDATE OF "key" ON "roles"
  FOR EACH ROW EXECUTE FUNCTION "forbid_role_key_change"();

-- Audit tables are APPEND-ONLY (NFR-14, FR-REG-21). Blocks UPDATE, DELETE and TRUNCATE for every
-- role, including the table owner. Archival (later) runs as the migrator role with the trigger
-- disabled inside a reviewed maintenance transaction.
CREATE FUNCTION "forbid_audit_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit table "%" is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;

CREATE TRIGGER "auth_events_append_only" BEFORE UPDATE OR DELETE ON "auth_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "auth_events_no_truncate" BEFORE TRUNCATE ON "auth_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();

CREATE TRIGGER "admin_audit_log_append_only" BEFORE UPDATE OR DELETE ON "admin_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_mutation"();
CREATE TRIGGER "admin_audit_log_no_truncate" BEFORE TRUNCATE ON "admin_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_mutation"();
