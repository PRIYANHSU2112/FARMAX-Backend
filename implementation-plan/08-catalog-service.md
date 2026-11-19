# 08 · catalog-service: Categories and sub-categories

_Status: **built** (2026-11-14). Lint, typecheck and unit/integration tests are green. The
migration `20261114000000_catalog_categories` has not yet been applied to a database._
Products, variants, pricing and search come in later plans.

## Scope

- A category tree of **any depth** (root → sub → sub-sub …) for the storefront and the admin
  panel.
- Port **3004**, package `@farmx/catalog-service`, layout `src/features/<f>/` (D-21).
- Gateway paths:
  - `/v1/catalog/*` → `/catalog/*`
  - `/v1/admin/catalog/*` → `/admin/catalog/*`
  - `/v1/catalog-service/health/*`
- Swagger: the **single** gateway UI at `/api-docs` (D-29).

## 1. Schema (`packages/database/prisma/schema/catalog/`)

### `categories.prisma`: `Category` → `categories`

| Field                             | Type                        | Notes                                                                          |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| id                                | uuid v7                     | generated in the app (the path ends with it)                                   |
| parentId                          | uuid?                       | adjacency list, null = root; FK to itself (same feature), `ON DELETE RESTRICT` |
| path                              | text                        | materialized path `/<rootId>/…/<id>/`                                          |
| depth                             | smallint                    | 0 = root; must be < `CATALOG_MAX_CATEGORY_DEPTH` (default 10 levels)           |
| name / nameTe                     | varchar(80) / varchar(120)? | English / Telugu                                                               |
| slug                              | varchar(100)                | URL key, unique among live categories                                          |
| description                       | varchar(1000)?              |                                                                                |
| imageUrl                          | varchar(500)?               | media-service URL                                                              |
| sortOrder                         | int                         | sibling order                                                                  |
| isActive                          | bool                        | false hides the node and its whole subtree on the storefront                   |
| version                           | int                         | optimistic lock (`If-Match`)                                                   |
| createdByUserId / updatedByUserId | uuid                        |                                                                                |
| createdAt / updatedAt / deletedAt | timestamp                   | soft delete                                                                    |

Raw SQL in the migration:

- partial index `path text_pattern_ops` (subtree = index range scan);
- partial unique indexes on `slug` and on the sibling name `(parent, lower(name))`, both for live
  rows only;
- CHECKs: `depth ≥ 0`, path ends with the row's own id, root ⇔ depth 0, a row is never its own
  parent.

### `audit.prisma`: `CatalogAuditLog` → `catalog_audit_log`

Same shape as `farm_audit_log`. Append-only through triggers (D-22).

## 2. Rules

1. **Create:** `path = parent.path + id + '/'` and `depth = parent.depth + 1`. Over the depth
   limit → 422. The slug is generated from the name (`live-vaccines`, `live-vaccines-2` …). A new
   category is placed last among its siblings.
2. **Move:** runs under a tree advisory lock.
   - Cycle (the new parent is the node itself or one of its descendants) → 422.
   - The branch would exceed the depth limit → 422.
   - One `UPDATE` rewrites `path` and `depth` for the whole subtree and bumps `version` on every
     moved row.
3. **Visibility:** a node is visible only if it is active and every ancestor is active (computed in
   memory).
4. **Delete:** soft delete. A node with live children → 409 `CATEGORY_HAS_CHILDREN`.
5. **Admin writes:**
   - each one needs a `reason` (10–500 chars) and writes an audit row in the same transaction;
   - `If-Match` → 409 `CATEGORY_VERSION_CONFLICT`;
   - slug clash → 409 `CATEGORY_SLUG_TAKEN`; sibling-name clash → 409 `CATEGORY_NAME_TAKEN`.
6. **Reorder:** `orderedIds` must list every live sibling exactly once. They get sortOrder
   10, 20, 30 … in one statement.

## 3. Performance

- **Storefront reads hit no database.** The whole live tree is one snapshot:
  - in-process LocalCache (30 s), then Redis (10 min, single-flight), then one indexed query;
  - one `CategoryIndex` (maps byId, bySlug, children, visible set) is built per snapshot, not per
    request.
- **Conditional reads:** a weak ETag over `(id, version)` of every row. `If-None-Match` → **304**
  with an empty body. Public reads send `Cache-Control: public, max-age=60, stale-while-revalidate=300`.
- **Writes:** one transaction plus one advisory lock. Caches are dropped after commit; other
  replicas converge within 30 s.
- **Admin lists:** keyset cursor with column-pruned selects. Child counts come from a `_count`
  sub-select, and `effectiveActive` from the cached index.

## 4. APIs (all in the single Swagger)

| #   | Method · gateway path                                                          | Auth / permission  | Notes                                          |
| --- | ------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------- |
| P1  | GET `/v1/catalog/categories?maxDepth`                                          | public, 120/min/IP | nested tree, ETag/304                          |
| P2  | GET `/v1/catalog/categories/{slug}`                                            | public             | category + breadcrumbs + children              |
| P3  | GET `/v1/catalog/categories/{slug}/subcategories?maxDepth=1`                   | public             | children, or n levels                          |
| A1  | GET `/v1/admin/catalog/categories?parentId=root\|uuid&q&isActive&cursor&limit` | catalogue.view     | flat list                                      |
| A2  | GET `/v1/admin/catalog/categories/tree`                                        | catalogue.view     | full tree, including inactive                  |
| A3  | GET `/v1/admin/catalog/categories/{id}`                                        | catalogue.view     | + ancestors, children, ETag version            |
| A4  | GET `/v1/admin/catalog/categories/{id}/history`                                | catalogue.view     | audit rows                                     |
| A5  | POST `/v1/admin/catalog/categories`                                            | catalogue.create   | `parentId` set = sub-category; Idempotency-Key |
| A6  | PATCH `/v1/admin/catalog/categories/{id}`                                      | catalogue.update   | If-Match, reason                               |
| A7  | POST `/v1/admin/catalog/categories/{id}/move`                                  | catalogue.update   | `{ parentId \| null, sortOrder?, reason }`     |
| A8  | POST `/v1/admin/catalog/categories/reorder`                                    | catalogue.update   | `{ parentId, orderedIds[], reason }`           |
| A9  | DELETE `/v1/admin/catalog/categories/{id}?reason=`                             | catalogue.update   | soft delete, 204                               |

## 5. Code

```
services/catalog-service/src/
  config · container · app · server · routes/index.ts (modules + spec tags)
  middleware/guards.ts       requireAuth, requirePermission, admin(), rateLimit, idempotent
  adapters/                  auth (JWT + AccessClient) · local-cache · uuid
  docs/shared.ts             headers, examples
  features/audit/            catalog_audit_log writer
  features/categories/       routes · controller · service · repository · validation · types · docs
                             · module · index · category.tree.ts (pure tree logic)
tests/unit/category.tree.test.ts · tests/integration/categories.routes.test.ts
```

## 6. Single Swagger (D-29)

`registerDocs` (common) now serves only the spec. The gateway feature `docs`
(`api-gateway/src/features/docs/`) fetches, merges and caches every spec and serves the UI through
`registerDocsUi`. A new service is one entry in `createDocsSources`.

## 7. Run

```
pnpm db:generate && pnpm db:migrate        # applies 20261114000000_catalog_categories
pnpm dev                                   # gateway :3000 … catalog :3004
open http://localhost:3000/api-docs
```
