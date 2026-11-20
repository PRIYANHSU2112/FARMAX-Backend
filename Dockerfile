# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ── 1. Build Stage ──
FROM base AS builder
ARG SERVICE_NAME=api-gateway
WORKDIR /app

# Install native compilation dependencies for argon2, sharp, and prisma
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy repository manifests and configurations
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.json ./
COPY packages/ ./packages/
COPY services/ ./services/

# Install dependencies (respecting catalog versions & workspaces)
RUN pnpm install --frozen-lockfile

# Generate Prisma client for @farmx/database
RUN pnpm db:generate

# Build the requested target service
RUN pnpm --filter @farmx/${SERVICE_NAME} build

# ── 2. Production Runner Stage ──
FROM base AS runner
ARG SERVICE_NAME=api-gateway
ENV SERVICE_NAME=${SERVICE_NAME}
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy built workspace files, node_modules, and compiled output
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services/${SERVICE_NAME} ./services/${SERVICE_NAME}

WORKDIR /app/services/${SERVICE_NAME}

EXPOSE 3000

CMD ["node", "dist/server.js"]
