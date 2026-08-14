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

## Testing

`apps/worker`'s integration tests run real Prisma queries against a real Postgres — by default
whatever `DATABASE_URL` is currently set to. **If you're already running the app via
`docker compose up` (i.e. `DATABASE_URL` points at that live database), do not run
`pnpm --filter @support-automation/worker test` against it directly** — some job functions
(session segmentation, pattern detection) scan globally by design, so exercising them against the
real database processes real production rows as a side effect, not just the test's own fixtures.

Use the isolated, throwaway test database instead:

```bash
docker compose -f docker-compose.test.yml up -d --wait   # starts postgres-test + runs migrations
pnpm --filter @support-automation/worker test:isolated    # points DATABASE_URL at postgres-test, not the live DB
docker compose -f docker-compose.test.yml down -v         # tear it down when done (drops all test data)
```

`docker-compose.test.yml` is a fully separate Compose project (its own network/volumes/containers)
from `docker-compose.yml` — safe to run both at once.

## Repository layout

```
apps/web       Next.js dashboard
apps/worker    dedicated OpenWA worker
packages/db    Prisma schema, migrations, client
packages/engine   rule evaluation engine (matchers, priority, regex safety)
packages/ai-client   AI-provider completion client (Anthropic today), used only by opt-in AI features
packages/shared   shared enums/types
```
