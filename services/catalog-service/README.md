# catalog-service

Product catalogue. Today it holds the **category tree**: categories and sub-categories to any
depth (adjacency list + materialized path, D-28). Port **3004**.
Plan: [implementation-plan/08-catalog-service.md](../../implementation-plan/08-catalog-service.md).

| Public (gateway)                 | Service                      | Who                                       |
| -------------------------------- | ---------------------------- | ----------------------------------------- |
| `/v1/catalog/categories/*`       | `/catalog/categories/*`      | public storefront (cache-first, ETag/304) |
| `/v1/admin/catalog/*`            | `/admin/catalog/*`           | INTERNAL staff + `catalogue.*`, audited   |
| `/v1/catalog-service/health/*`   | `/health/*`                  | probes                                    |
| `http://localhost:3000/api-docs` | `/api-docs.json` (spec only) | the ONE Swagger for all services (D-29)   |

```
pnpm db:migrate                                   # applies 20261114000000_catalog_categories
pnpm --filter @farmx/catalog-service dev
```
