# Support Message Automation

Rule-based WhatsApp support automation: a Next.js dashboard, a dedicated
OpenWA worker, and a PostgreSQL/Prisma backend, run via Docker Compose.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the durable system design, and
[PROJECT_REFERENCE.md](./PROJECT_REFERENCE.md) for an exhaustive, page-by-page reference of every
module, field, and behavior in the app.

## Status

Well past the original foundation phase. Shipped and live: multi-account WhatsApp connections with
per-service account routing, the rule engine (keyword/exact/contains/regex matching, priority
resolution, a dry Rule Tester), the DB-backed outbound send queue, Group Message Sender (manual +
Excel bulk broadcast) and Add Number to Groups, Priority-Based Support Escalation, Conversation
Learning (deterministic pattern detection + optional AI-assisted analysis + human-reviewed rule
proposals), Support Activity Tracking (keyword/reply/mention detection with configurable counting),
a consolidated command-center dashboard, and a floating AI Admin Assistant chat widget. AI Learning
(a knowledge-base + provider/model configuration module) is intentionally a foundation-only phase —
see `PROJECT_REFERENCE.md` for exactly what is and isn't live yet.

## Requirements

- Docker + Docker Compose
- Node.js 22.13+ and pnpm (for local development outside Docker)

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

After adding a schema migration, remember it must still be **deployed** to whichever database is
actually running the app (`pnpm db:migrate:deploy`, or the equivalent inside your deploy process) —
a migration committed to the repo but not deployed will eventually surface as a live `P2022`
"column does not exist" error the next time someone touches an affected query.

## Repository layout

```
apps/web       Next.js dashboard — pages, server actions, the AI Admin Assistant chat widget
apps/worker    dedicated OpenWA worker — message pipeline, outbound queue, escalation/learning/support-activity jobs
packages/db    Prisma schema, migrations, client
packages/engine   rule evaluation engine (matchers, priority, regex safety, pattern-detection scoring)
packages/ai-client   text-only AI-provider completion client (Anthropic today), used only by the worker's opt-in Conversation Learning AI analysis job
packages/shared   shared enums/types
```

## Further reading

- `ARCHITECTURE.md` — component boundaries, data model, and the design decisions behind them.
- `PROJECT_REFERENCE.md` — every module, page, field, and behavior in the app, in one place.
- `ENGINEERING_STANDARDS.md` — the living rulebook for ongoing work (idempotency, anti-spam
  philosophy, production safety checklist, etc.).
- The four root-level `*.md` build-spec documents (`RULE-BASED SUPPORT MESSAGE AUTOMATION.md`,
  `WHATSAPP ACCOUNT SAFETY AND ANTI-SPAM REQUIREMENTS.md`,
  `Priority-Based Support Monitoring & Escalation — Implementation Command.md`,
  `AI Learning & Knowledge System — Full Development Prompt.md`, and the newer
  `Support Activity Tracking + AI Admin Assistant — Safe Integration Master Prompt.md`) — original
  build specs for each major feature area, useful for rationale/intent.
