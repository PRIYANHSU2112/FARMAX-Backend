# api-gateway

**Owns:** the public entry point. It proxies requests to services by path prefix ([route-map.ts](src/features/proxy/route-map.ts); upstream URLs in [config/services.ts](src/config/services.ts)). It owns no database and no tables.
**Port:** 3000 (`GATEWAY_PORT`). It is the only public service.
**Routes:** `/health/live`, `/health/ready`, and `/v1/auth/*` → auth-service at `/*` (`AUTH_SERVICE_URL`, default `http://localhost:3001`).
**Not built yet:** JWT verification against the auth-service JWKS, the revoked-session check in Redis, rate limits and aggregated API docs.
**Events:** publishes none and consumes none.
**Run:** `pnpm infra:up`, then `pnpm dev` from the repo root (starts both services), or `pnpm --filter @farmx/api-gateway dev`.
**Test / build:** `pnpm --filter @farmx/api-gateway test` · `pnpm --filter @farmx/api-gateway build` → `dist/server.js`.
**Env:** root `.env`.
