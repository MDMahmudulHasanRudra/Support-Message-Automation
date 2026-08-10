# Support Message Automation

Rule-based WhatsApp support automation: a Next.js dashboard, a dedicated
OpenWA worker, and a PostgreSQL/Prisma backend, run via Docker Compose.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the locked system design.

Status: **Phase 1 — Project Foundation.** OpenWA, automation rules, and
notifications are not implemented yet.

## Requirements

- Docker + Docker Compose
- Node.js 20+ and pnpm (for local development outside Docker)

## Getting started

```bash
cp .env.example .env      # fill in real values
docker compose up -d --build
docker compose ps         # all three services should report healthy
```

- Dashboard: http://localhost:3000
- Health checks: `GET /api/health` (web), internal-only on the worker (see `ARCHITECTURE.md`)

## Local development (without Docker)

```bash
pnpm install
pnpm --filter @support-automation/db generate
pnpm dev:web       # apps/web on :3000
pnpm dev:worker    # apps/worker
```

Requires a local `DATABASE_URL` pointing at a reachable Postgres instance.

## Repository layout

```
apps/web       Next.js dashboard
apps/worker    dedicated OpenWA worker
packages/db    Prisma schema, migrations, client
packages/engine   rule evaluation engine (matchers, priority, regex safety)
packages/shared   shared enums/types
```
