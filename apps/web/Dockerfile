# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
# Prisma's runtime engine-detection needs the `openssl` CLI to correctly
# identify the OpenSSL version (bookworm ships 3.0.x); without it detection
# silently falls back to a wrong "openssl-1.1.x" binary target and every
# Prisma query fails at runtime with "cannot find libssl.so.1.1".
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc* tsconfig.base.json ./
# pnpm-workspace.yaml's patchedDependencies (Phase 5.1, for @open-wa/wa-automate)
# is workspace-wide — `--frozen-lockfile` validates the whole lockfile even
# when filtered to this app, so the patch file must be present here too.
COPY patches patches
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/teams-client/package.json packages/teams-client/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install -g pnpm@11.9.0
RUN pnpm install --frozen-lockfile --filter @support-automation/web...

# ---------------------------------------------------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/engine packages/engine
COPY packages/teams-client packages/teams-client
COPY apps/web apps/web
RUN pnpm --filter @support-automation/db generate
# packages/shared, packages/engine, and packages/teams-client ship compiled
# dist/*.js (see apps/worker/Dockerfile for why) — Next's build needs the
# real files present to resolve and trace them into the standalone output.
RUN pnpm --filter @support-automation/shared build
RUN pnpm --filter @support-automation/engine build
RUN pnpm --filter @support-automation/teams-client build
RUN pnpm --filter @support-automation/web build

# ---------------------------------------------------------------------------
FROM base AS runtime
# Docker auto-sets HOSTNAME to the container ID, and Next's standalone
# server.js binds to process.env.HOSTNAME when set — without this override
# it listens only on the container's bridge-network address, not loopback,
# which silently breaks the container's own HEALTHCHECK (127.0.0.1:3000).
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0

# Next.js standalone output already contains a minimal node_modules subset
# and a server entrypoint — no full pnpm install needed at runtime.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "server.js"]
