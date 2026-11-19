-- Shared FarmX database roles: least privilege for the application, full DDL for migrations.
-- Idempotent. Run as a superuser against farmx AFTER `pnpm db:migrate`, and again after
-- each migration that adds tables (default privileges cover tables created by farmx_migrator).
-- Optional locally; required in production.
--
--   psql "postgres://<superuser>@host/farmx" -v app_password="'...'" -v migrator_password="'...'" -f roles.sql
--
-- Then point every service at:
--   DATABASE_URL          = postgres://farmx_app:...@host/farmx         (runtime)
--   MIGRATE_DATABASE_URL  = postgres://farmx_migrator:...@host/farmx    (prisma migrate / seed)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farmx_migrator') THEN
    CREATE ROLE farmx_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farmx_app') THEN
    CREATE ROLE farmx_app LOGIN;
  END IF;
END $$;

ALTER ROLE farmx_migrator PASSWORD :migrator_password;
ALTER ROLE farmx_app PASSWORD :app_password;

GRANT CONNECT ON DATABASE farmx TO farmx_migrator, farmx_app;
GRANT USAGE, CREATE ON SCHEMA public TO farmx_migrator;
GRANT USAGE ON SCHEMA public TO farmx_app;

-- Runtime: read/write business tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO farmx_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO farmx_app;
ALTER DEFAULT PRIVILEGES FOR ROLE farmx_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO farmx_app;
ALTER DEFAULT PRIVILEGES FOR ROLE farmx_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO farmx_app;

-- Audit tables are append-only for the application. The triggers in the migration also block
-- these operations for every role; the REVOKE is defence in depth.
REVOKE UPDATE, DELETE, TRUNCATE ON "auth_events", "admin_audit_log" FROM farmx_app;
GRANT SELECT, INSERT ON "auth_events", "admin_audit_log" TO farmx_app;

-- The application must never alter schema or disable triggers.
REVOKE CREATE ON SCHEMA public FROM farmx_app;
