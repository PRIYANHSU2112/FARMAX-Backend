# farm-service

Farm owners, farm units and the permanent **Farm ID** (`FX-WG-L-00418`): 5-step registration,
backyard quick sign-up, KYC (Aadhaar OTP, PAN, GSTIN, documents), duplicate review and admin
management. Port **3003**. Plan: [implementation-plan/07-farm-service.md](../../implementation-plan/07-farm-service.md).

| Public (gateway)    | Service             | Who                                                         |
| ------------------- | ------------------- | ----------------------------------------------------------- |
| `/v1/farms/*`       | `/farms/*`          | customers (own farms only; others → 404)                    |
| `/v1/admin/farms/*` | `/admin/farms/*`    | INTERNAL staff + permission key, audited                    |
| gateway `/api-docs` | `/api-docs.json`    | the ONE Swagger for all services (D-29)                     |
| —                   | `/internal/farms/*` | other services (`x-internal-token`), blocked at the gateway |

```
src/features/  farms (journey, Farm ID, admin, internal) · geo (pin → territory/node)
               kyc (Aadhaar, PAN, GSTIN, documents) · review (duplicate cases) · audit (farm_audit_log)
src/adapters/  auth (JWT verify, permission cache client) · kyc-providers (fake + guard)
               pii-crypto (AES-GCM, HMAC) · outbox.repository · local-cache (LRU)
scripts/seed-geo.ts   territories + pin codes for the launch belt
```

```
pnpm db:migrate                                   # applies 20261113000000_farm_service
pnpm --filter @farmx/farm-service db:seed         # territories + pin codes
pnpm --filter @farmx/farm-service dev
```

Performance: farm detail, my farms, pass, pin lookup are cache-first (Redis single-flight; pin
codes also in an in-process LRU). Writes are one transaction with optimistic locking
(`If-Match`), side effects after commit. Dedupe is one SQL statement over three indexes
(PAN hash, GSTIN, GiST earthdistance).
