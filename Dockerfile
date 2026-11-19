# syntax=docker/dockerfile:1.7
#
# ONE Dockerfile for every FarmX service (pnpm + Turborepo monorepo).
#   docker build --build-arg SERVICE=auth-service -t farmx/auth-service .
#   docker build --build-arg SERVICE=auth-service --target migrator -t farmx/migrator .
#
# Stages:
#   pruner   → `turbo prune` keeps only the service + the workspace packages it uses
#   builder  → install (cached pnpm store), prisma generate + tsup build, `pnpm deploy --prod`
#   migrator → full workspace with the Prisma CLI: `prisma migrate deploy` (one-shot job)
#   runner   → slim runtime: dist/ + production node_modules only, non-root, tini as PID 1

ARG NODE_VERSION=22.20.0
ARG PNPM_VERSION=10.34.9
ARG TURBO_VERSION=2.11.10

# ── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    HUSKY=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ── pruner: a minimal monorepo for one service ───────────────────────────────
FROM base AS pruner
ARG SERVICE
ARG TURBO_VERSION
RUN test -n "$SERVICE" || (echo "--build-arg SERVICE=<name>-service is required" && exit 1)
COPY . .
RUN pnpm dlx turbo@${TURBO_VERSION} prune "@farmx/${SERVICE}" --docker

# ── builder: install → generate → build → production bundle ──────────────────
FROM base AS builder
ARG SERVICE
# 1. Manifests + lockfile only: this layer (the slow install) is reused until dependencies change.
COPY --from=pruner /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# 2. Sources, then build (turbo runs `prisma generate` first: build dependsOn db:generate).
COPY --from=pruner /repo/out/full/ ./
RUN pnpm exec turbo run build --filter="@farmx/${SERVICE}" --output-logs=errors-only
# 3. The service's PRODUCTION dependencies only (workspace packages are bundled into dist by tsup;
#    their third-party deps are listed in the service's package.json and stay external).
#    prune-runtime.mjs then drops the optional-peer tooling pnpm still links (prisma CLI, TypeScript).
COPY infra/docker/prune-runtime.mjs /tmp/prune-runtime.mjs
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "@farmx/${SERVICE}" deploy --prod --legacy /prod/app \
 && node /tmp/prune-runtime.mjs /prod/app \
 && cp -r "services/${SERVICE}/dist" /prod/app/dist

# ── migrator: one-shot `prisma migrate deploy` against DATABASE_URL ──────────
FROM builder AS migrator
WORKDIR /repo/packages/database
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ── runner: what actually runs in production ─────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runner
ARG SERVICE
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    SERVICE=${SERVICE}
WORKDIR /app
COPY --from=builder --chown=node:node /prod/app/package.json ./package.json
COPY --from=builder --chown=node:node /prod/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /prod/app/dist ./dist
USER node
# tini: forwards SIGTERM so Fastify's graceful shutdown runs, and reaps zombie processes (ffmpeg).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
