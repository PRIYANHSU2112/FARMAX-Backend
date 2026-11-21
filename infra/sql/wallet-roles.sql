-- D-54 W6: only wallet-service can touch the wallet and reward-points ledgers.
--
-- Run as the database OWNER after every `prisma migrate deploy` (idempotent; re-running also
-- covers tables added by new migrations). Migrations keep using the OWNER url; services use:
--   wallet-service  → farmx_wallet   (wallet_* / points_* + outbox / inbox, nothing else)
--   every other one → farmx_app      (everything EXCEPT wallet_* / points_*)
--
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -v wallet_password='…' -v app_password='…' -f infra/sql/wallet-roles.sql
--
-- The ledger triggers (append-only, sum-zero, balance chain) apply to every role, the owner too.

SELECT format('CREATE ROLE %I LOGIN', r)
  FROM unnest(ARRAY['farmx_wallet', 'farmx_app']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec

ALTER ROLE farmx_wallet PASSWORD :'wallet_password';
ALTER ROLE farmx_app PASSWORD :'app_password';

SELECT format('GRANT CONNECT ON DATABASE %I TO farmx_wallet, farmx_app', current_database())
\gexec
GRANT USAGE ON SCHEMA public TO farmx_wallet, farmx_app;

-- Everyone but wallet-service: all tables and sequences …
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO farmx_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO farmx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO farmx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO farmx_app;

-- … except the ledgers: no read, no write.
SELECT format('REVOKE ALL ON TABLE %I FROM farmx_app, PUBLIC', tablename)
  FROM pg_tables
 WHERE schemaname = 'public' AND (tablename LIKE 'wallet\_%' OR tablename LIKE 'points\_%')
\gexec
SELECT format('REVOKE ALL ON SEQUENCE %I FROM farmx_app, PUBLIC', sequencename)
  FROM pg_sequences
 WHERE schemaname = 'public' AND (sequencename LIKE 'wallet\_%' OR sequencename LIKE 'points\_%')
\gexec

-- wallet-service: its own tables + the shared outbox / inbox, and nothing else.
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO farmx_wallet', tablename)
  FROM pg_tables
 WHERE schemaname = 'public'
   AND (tablename LIKE 'wallet\_%' OR tablename LIKE 'points\_%'
        OR tablename IN ('outbox_events', 'processed_events'))
\gexec
SELECT format('GRANT USAGE, SELECT ON SEQUENCE %I TO farmx_wallet', sequencename)
  FROM pg_sequences
 WHERE schemaname = 'public' AND (sequencename LIKE 'wallet\_%' OR sequencename LIKE 'points\_%')
\gexec
