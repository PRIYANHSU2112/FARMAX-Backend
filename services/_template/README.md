# service-template

Starting point for a new FarmX service, with the same layout as auth-service. It is a workspace
package, so typecheck, lint and test keep it compiling, but `pnpm dev` never starts it.

```
src/
  features/<feature>/   routes · controller · service · repository · validation · types · module · index
  routes/index.ts       list of features
  config/index.ts       env schema (DATABASE_URL is the shared one)
  middleware/           service-specific hooks (require-auth.ts)
  container.ts          config, logger, db (shared singleton), runInTransaction
  app.ts                builds the app, no listen
  server.ts             listen + graceful shutdown
tests/unit · tests/integration
```

## Create a service

1. `cp -r services/_template services/<name>-service`, without `node_modules`, `dist` or `.turbo`.
2. In `package.json`, set the name to `@farmx/<name>-service`. In `src/config/index.ts`, set `SERVICE_NAME` and the port variable (e.g. `<NAME>_SERVICE_PORT`, default `3002`).
3. Add your models to `packages/database/prisma/schema/<name>/<feature>.prisma`, then run `pnpm db:migrate --name <change>`. Every service uses the one database.
4. Replace `features/example` with your features, using the same file set, and switch each repository to `this.db` (see the comment in `example.repository.ts`).
5. Add the service to the root `dev` script and to the gateway's `src/config/services.ts` and route map.
