# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install -g pnpm@11.9.0
RUN pnpm install --frozen-lockfile --filter @support-automation/web...

# ---------------------------------------------------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/engine packages/engine
COPY apps/web apps/web
RUN pnpm --filter @support-automation/db generate
RUN pnpm --filter @support-automation/web build

# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# Next.js standalone output already contains a minimal node_modules subset
# and a server entrypoint — no full pnpm install needed at runtime.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "server.js"]
