# 05 — Services with Features Inside

_Decided 2026-11-04. Revised 2026-11-10 (microservices) and 2026-11-11 (`features/` layout, one shared
database — D-21)._

FarmX is a set of **services** (`api-gateway`, `auth-service`, later catalog, order, …) that deploy
independently and talk over **internal HTTP** or **RabbitMQ events**. Inside, each service is split
into **features** with hard boundaries. All services use **one shared database** through
`@farmx/database` ([06](06-single-shared-database.md)).

```text
client ── HTTPS ──► api-gateway ── internal HTTP ──► auth-service / <service> …
                                                       │ features → repositories
                                                       ▼
                                          @farmx/database → Postgres `farmx`
                         events: outbox → RabbitMQ `events` → consumer inbox
```

## Shared vs not shared

| Shared packages                                                              | Never shared                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| `@farmx/common`: config, logger, errors, response, types, middleware, server | A service's source code                        |
| `@farmx/database`: schema, migrations, singleton client, DB helpers          | Business rules (they live in one feature)      |
| `@farmx/infra`: redis clients + keys, event envelope + contracts             | Another feature's tables (query only your own) |
| `@farmx/tsconfig`, `@farmx/eslint-config`                                    |                                                |

Layout of a service: see [01](01-folder-structure.md#a-service). New services start from
`services/_template`.

## Rules

| #   | Rule                                                                                                                    | Enforced by                      |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | A service never imports another service's code                                                                          | ESLint `farmx/module-boundaries` |
| 2   | A feature queries only its own models; other services' data comes over HTTP or events                                   | Code review                      |
| 3   | Shared packages contain no business logic and never import from `services/`                                             | Code review                      |
| 4   | A feature imports another feature **only** through `features/<name>/index.ts`                                           | ESLint `farmx/module-boundaries` |
| 5   | Only `*.repository.ts` and `container.ts` use the database client (`@farmx/database/client`)                            | ESLint `no-restricted-imports`   |
| 6   | Each model belongs to one feature: `packages/database/prisma/schema/<service>/<feature>.prisma`                         | Code review                      |
| 7   | No Prisma relations across features; store the other id as a plain indexed column                                       | Code review                      |
| 8   | Cross-feature calls go through the other feature's service (Awilix, e.g. `sessionsService`)                             | Code review                      |
| 9   | One action = one transaction: `runInTransaction(tx => …)`, pass `tx` to other features; Redis side effects after commit | Code review                      |
| 10  | DI keys are prefixed with the feature name: `usersService`, `usersRepository`, `usersController`                        | Convention                       |
| 11  | BullMQ queues are owned by one feature: `<service>.<feature>-<job>`, e.g. `auth.sessions-cleanup`                       | Convention                       |
| 12  | Event types are versioned `<aggregate>.<event>.v<N>`; a contract change is a new version                                | Code review                      |

## The feature contract (`@farmx/common/server`)

```ts
// src/features/users/users.module.ts
export const usersModule = defineModule({
  name: 'users',
  prefix: '/admin/users',
  register: (container) => {
    container.register({
      usersRepository: asClass(UsersRepository).singleton(),
      usersService: asClass(UsersService).singleton(),
      usersController: asClass(UsersController).singleton(),
    });
  },
  routes: usersRoutes,
});

// src/routes/index.ts
export const features = [authModule, usersModule, accessModule, sessionsModule, auditModule];
```

`buildService` checks feature names, calls each `register()`, mounts routes at `prefix`, and adds
health checks to `/health/ready`.

## Features today

| Service      | Feature    | Owns                                                                                                         |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------------------ |
| api-gateway  | `proxy`    | Route map (prefix → upstream); later JWT check, rate limits                                                  |
| auth-service | `users`    | `User`; admin user APIs (`/admin/users`)                                                                     |
| auth-service | `auth`     | `Credential`, `PasswordHistory`, `MfaFactor`, `MfaRecoveryCode`, `UserDevice`, `AuthEvent`; password hashing |
| auth-service | `access`   | `Role`, `Permission`, `RolePermission`, `UserRole`; permission catalog, `requirePermission`                  |
| auth-service | `sessions` | `Session`; revoke + Redis revoked-sid flags                                                                  |
| auth-service | `audit`    | `AdminAuditLog` (append-only); `/admin/audit-logs`                                                           |

## Moving a feature to its own service later

Copy `_template`, move `features/<name>/`, keep its schema folder in `@farmx/database`, and replace
in-process calls with internal HTTP or events. Rules 2, 6 and 7 mean there are no joins to untangle.
