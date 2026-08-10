# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# OpenWA needs a real Chromium + its native dependencies. Chromium/Puppeteer
# compatibility is the single most fragile part of this build (see
# ARCHITECTURE.md, high-risk area #1) — pin this tag to a digest before
# production hardening (Phase 9) so the base image can't shift under us.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    dumb-init \
    curl \
    openssl \
  && rm -rf /var/lib/apt/lists/*
# `openssl` above is required for Prisma's runtime engine-detection (bookworm
# ships OpenSSL 3.0.x); without the CLI, detection silently falls back to a
# wrong "openssl-1.1.x" binary target and every Prisma query fails at
# runtime with "cannot find libssl.so.1.1" (caught during the web image's
# build — worker's build stage never executes a query so it wouldn't have
# surfaced until the container actually ran).

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm install -g pnpm@11.9.0
RUN pnpm install --frozen-lockfile --filter @support-automation/worker...

# ---------------------------------------------------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/engine packages/engine
COPY apps/worker apps/worker
RUN pnpm --filter @support-automation/db generate
# packages/shared and packages/engine are consumed as compiled dist/*.js by
# every runtime (plain Node here, Turbopack in apps/web) — building them
# here, not just type-checking, is required or the worker's `node
# dist/index.js` fails at runtime with ERR_MODULE_NOT_FOUND trying to load
# their .ts source directly (no transpiler is present outside of dev/tsx).
RUN pnpm --filter @support-automation/shared build
RUN pnpm --filter @support-automation/engine build
RUN pnpm --filter @support-automation/worker build

# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# pnpm's workspace symlinks (e.g. apps/worker/node_modules/@support-automation/db
# -> ../../../packages/db) live INSIDE each package's own node_modules, not
# hoisted to the root — root node_modules only holds the real .pnpm store
# these symlinks point into. All three copies are required for Node's
# module resolution to find anything at runtime.
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/worker/node_modules /app/apps/worker/node_modules
COPY --from=build /app/apps/worker/dist /app/apps/worker/dist
COPY --from=build /app/apps/worker/package.json /app/apps/worker/package.json

WORKDIR /app/apps/worker

RUN mkdir -p /app/sessions

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
