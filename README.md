# Softify Assist

Rule-based WhatsApp support automation: a Next.js dashboard, a dedicated
OpenWA worker, and a PostgreSQL/Prisma backend, run via Docker Compose.

Runs in production at **https://assist.softifybd.com**.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the durable system design, and
[PROJECT_REFERENCE.md](./PROJECT_REFERENCE.md) for an exhaustive, page-by-page reference of every
module, field, and behavior in the app.

## Status

**Most recent additions:**

- **Release Notes.** A permanent, publishable changelog — draft, publish, unpublish, archive, with
  a full edit history kept for anything already public. No historical entries were invented; the
  table ships empty because nothing in this repo's git history or `package.json` reliably names a
  real past release.
- **Team Management.** Shifts, a weekly pattern, a daily roster, leave, and coverage that counts
  who can *actually* work — approving leave keeps the duty row and subtracts the person, so a
  shift reads as "short by 1" rather than quietly looking empty. Attendance is derived from the
  messages people really sent, and is treated as evidence rather than a verdict: a scheduled day
  with no messages reads "no activity recorded", never "absent". Only a manager can mark somebody
  absent, and that correction is stored *beside* the evidence, never over it.
- **Product knowledge from the ISPDIGITAL repository.** The assistant reads the product's own user
  guides and module source through Softify Forge, so it can answer "how do I void an invoice" on a
  fresh install. A mechanical disclosure gate re-checks every generated entry and drops anything
  naming code, schema, tables, endpoints or infrastructure — the prompt is not trusted to do that
  job. See `FORGE_SETUP.md`.
- **Four AI response modes**, from "verified knowledge only" (the default) up to knowledge +
  live product-source research + general knowledge. With research on, a question nothing covers is
  looked up while the customer waits and the answer is kept for next time. What is *not*
  configurable, under any mode: a question about this company's own product, policies or accounts
  is answered only from verified knowledge, or it goes to a person.
- **A default reply language** (Bangla, English, Banglish, or type your own), with the model
  deciding and reporting the language before it drafts — so a one-word "hello" no longer swings the
  whole reply into another language.
- **Notification Center.** Alerts now carry a reason (escalation, AI handover, rule notify,
  unknown pattern), each independently switchable, channelled and routed — and team members can
  opt into direct messages for the events they personally want, per event.
- **Support Activity rebuilt** around who handled what and for how long: per-executive groups,
  messages and engaged time for today, this week and this month, read from the activity rows
  themselves rather than from sessions that may never close.
- **AI can ask a person by name** in the customer's own group when it hands over, instead of only
  alerting a separate group the customer cannot see.
- **Communication-style learning** — the assistant can learn how your executives write (never what
  they claim), and nothing reaches a customer until a person approves the guidance.
- Knowledge imports from **URLs, PDFs, Word files and spreadsheets**; **Google Gemini** as a
  provider; a **Teams CSV/xlsx export**; searchable, paginated high-volume lists; loading and error
  states on every page; and touch-sized controls on phones and tablets.

> **Deploying requires running the pending migrations** — `pnpm db:migrate:deploy` before starting
> the new build. Every one is additive, and each new column defaults to the behaviour that existed
> before it, so an existing deployment behaves identically until someone changes a setting.


Well past the original foundation phase. Shipped and live: multi-account WhatsApp connections with
per-service account routing, the rule engine (keyword/exact/contains/regex matching, priority
resolution, a dry Rule Tester), the DB-backed outbound send queue, Group Message Sender (manual +
Excel bulk broadcast) and Add Number to Groups, Priority-Based Support Escalation, Conversation
Learning (deterministic pattern detection + optional AI-assisted analysis + human-reviewed rule
proposals), Support Activity Tracking (keyword/reply/mention detection with configurable counting),
a Hybrid AI Automation fallback layer (AI-assisted auto-reply only when the rule engine genuinely
misses, with human-takeover cooldown), a consolidated command-center dashboard, a floating AI Admin
Assistant chat widget, and a Microsoft Teams Integration (P0 slice: one-click, password-free OAuth
connection — Connect → Microsoft login → Allow → Connected, with automatic Teams/channel discovery
and an optional Manage Teams & Channels selection screen — Teams/channel/message sync,
resolution-keyword detection, and automatic WhatsApp customer notification, linked to WhatsApp
conversations via a new Issue-tracking model — see `TEAMS_SETUP.md` to configure), a
WhatsApp-Web-style Chat inbox, and AI Learning — no longer a foundation-only phase: the knowledge
base is now written to by three sources (group conversations, manual imports, and the product's own
repository via Softify Forge), read back by every AI answer, and gated by a human-verification
queue that only verified entries escape.

Deliberately **not** built, each for a stated reason rather than for lack of time: `REACTION` as a
support trigger (OpenWA's `onReaction` is behind an Insiders licence this deployment does not have,
so it would look configured and never fire once), Microsoft Graph real-time webhooks (they need a
publicly reachable HTTPS endpoint; this runs on a private port, so the code would register and
never receive), Teams session/duration analytics (nothing to compute from yet — the export exists
for the day someone connects it), and the `CUSTOM` AI provider kind (every OpenAI-compatible
endpoint is already reachable by choosing OpenAI and setting the API URL). See
`PROJECT_REFERENCE.md` for exactly what each module does today.

## Requirements

- Docker + Docker Compose
- Node.js 22.13+ and pnpm (for local development outside Docker)

## Getting started

```bash
cp .env.example .env      # fill in real values
docker compose up -d --build
docker compose ps         # postgres, app and worker should report healthy (migrate is one-shot)
```

- Dashboard: http://localhost:8668 (the host port is `WEB_PORT`, default 8668; the container still listens on 3000)
- Health checks: `GET /api/health` (web), internal-only on the worker (see `ARCHITECTURE.md`)

## Local development (without Docker)

```bash
pnpm install
pnpm --filter @support-automation/db generate
PORT=8668 pnpm dev:web   # apps/web — pick any free port; NEXTAUTH_URL must match it
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
apps/worker    dedicated OpenWA worker — message pipeline, outbound queue, escalation/learning/support-activity/teams jobs
packages/db    Prisma schema, migrations, client
packages/engine   rule evaluation engine (matchers, priority, regex safety, pattern-detection scoring)
packages/ai-client   text-only, no-tools AI completion client (Anthropic, OpenAI, OpenRouter, Ollama, Google), used by every worker-side AI job
packages/forge-client   Softify Forge REST wrapper + the disclosure gate deciding what a customer may be told
packages/teams-client   Microsoft OAuth + Graph API wrapper, used by apps/web (connect flow) and apps/worker (sync)
packages/shared   shared enums/types
```

## Further reading

- `ARCHITECTURE.md` — component boundaries, data model, and the design decisions behind them.
- `PROJECT_REFERENCE.md` — every module, page, field, and behavior in the app, in one place.
- `ENGINEERING_STANDARDS.md` — the living rulebook for ongoing work (idempotency, anti-spam
  philosophy, production safety checklist, etc.).
- `TEAMS_SETUP.md` — how to register the Azure App Registration the Microsoft Teams Integration
  needs (client ID/secret/tenant ID/redirect URI) — required before that feature can connect.
- `FORGE_SETUP.md` — how to point the product-knowledge integration at Softify Forge and the
  ISPDIGITAL repository, what each of its three tiers reads, and what the disclosure gate blocks.
- The five root-level `*.md` build-spec documents (`RULE-BASED SUPPORT MESSAGE AUTOMATION.md`,
  `WHATSAPP ACCOUNT SAFETY AND ANTI-SPAM REQUIREMENTS.md`,
  `Priority-Based Support Monitoring & Escalation — Implementation Command.md`,
  `AI Learning & Knowledge System — Full Development Prompt.md`, and the newer
  `Support Activity Tracking + AI Admin Assistant — Safe Integration Master Prompt.md`) — original
  build specs for each major feature area, useful for rationale/intent.
