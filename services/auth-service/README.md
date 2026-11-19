# auth-service

**Owns:** identity and access. Its tables are in the shared database `farmx` (schema: `packages/database/prisma/schema/auth/`). Features and their tables: `users` (User), `auth` (Credential, PasswordHistory, MfaFactor, MfaRecoveryCode, UserDevice, AuthEvent), `access` (Role, Permission, RolePermission, UserRole), `sessions` (Session) and `audit` (AdminAuditLog, append-only).
**Port:** 3001 (`AUTH_SERVICE_PORT`), internal only. Reached through the gateway as `/v1/auth/*`.
**Routes:** see Swagger (`/api-docs`). Groups:

- `/auth/*`: customer OTP login, admin login + MFA, refresh, logout(-all), password forgot/reset/change (public routes are rate-limited)
- `/me`, `/me/sessions`, `/me/mfa/totp/*`: self-service
- `/admin/users` (CRUD, roles, block/unblock, sessions, force-logout), `/admin/roles`, `/admin/permissions`, `/admin/audit-logs`
- `/.well-known/jwks.json`, `/health/*`: public

Every `/admin/*` route needs a Bearer access token plus a permission from [permissions.catalog.ts](src/features/access/permissions.catalog.ts).
**Secrets:** `pnpm --filter @farmx/auth-service keys:generate` prints JWT keys, `OTP_PEPPER` and `MFA_ENCRYPTION_KEY` for `.env` (required on dev/prod; local uses ephemeral ones). Dev OTPs are logged by the console SMS adapter.

**API docs:** the single FarmX Swagger UI at `http://localhost:3000/api-docs` (gateway, all services, D-29). This service only publishes its spec at `http://localhost:3001/api-docs.json`. Postman: Import → Link → `http://localhost:3000/api-docs.json`. Sections: Health (public), Admin Users, Admin Audit Logs; Auth and User appear when built. Off in prod unless `DOCS_ENABLED=true`. Per-route docs live in `features/<feature>/<feature>.docs.ts`.
**Events:** publishes none yet. Planned, through the outbox: `auth.user_*` and `auth.session_compromised.v1`. Consumes none. It writes `revoked:sid:<id>` flags to Redis, which the gateway will check.
**Layout:** `src/features/{tokens,auth,sessions,users,access,audit}`, `src/routes/index.ts`, `scripts/{seed,generate-keys}.ts`, `tests/unit` + `tests/integration`.
**Run:** `pnpm infra:up` → `pnpm db:migrate` → `pnpm db:seed` (needs the `SEED_ADMIN_*` env vars) → `pnpm dev`. To run only this service: `pnpm --filter @farmx/auth-service dev`.
**Test / build:** `pnpm --filter @farmx/auth-service test` · `pnpm --filter @farmx/auth-service build` → `dist/server.js`.
**Env:** root `.env`: the shared `DATABASE_URL`, `REDIS_CACHE_URL`, `SEED_ADMIN_*`, `DOCS_*`.
