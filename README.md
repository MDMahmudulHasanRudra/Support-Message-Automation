# Softify Assist

Rule-based WhatsApp support automation: a Next.js dashboard, a dedicated
OpenWA worker, and a PostgreSQL/Prisma backend, run via Docker Compose.

Runs in production at **https://assist.softifybd.com**.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the durable system design, and
[PROJECT_REFERENCE.md](./PROJECT_REFERENCE.md) for an exhaustive, page-by-page reference of every
module, field, and behavior in the app.

## Status

**Most recent additions:**

- **Support Assignment** (Support → Support Assignment). Every customer waiting for a reply becomes a
  case, unless it is only "thanks"/"ok" or from an ignored sender (filtered cases are kept and
  counted). Assign one or many cases to a person; they get a WhatsApp message. The case completes
  itself when that person replies in the group. If they do not reply within the SLA, the manager
  group and admins are told, with optional escalation. Includes My assignments, Completed, full
  history per case, and a report (also under All Reports) with Excel/CSV. Off by default; needs the
  Support Team chosen. Built locally on `rudra`; not committed, not deployed (`SUPPORT_ASSIGNMENT.md`).

- **Faster group sync for a second account** (WhatsApp → Accounts / Groups). A newly linked number's
  groups now appear as the phone delivers them (re-read every 30 s until settled) instead of at a
  5-minute pass; one account's sync no longer holds another's; each account shows its own sync
  progress; a Logout or Reconnect stops a running sync cleanly (shown as stopped, not failed).
  Built locally on `rudra`; not deployed (`GROUP_SYNC.md`).
- **Mood Detection** (Settings → Support → Mood Detection). Notices an angry, frustrated or urgent
  customer and does only what you choose per mood: pause AI or require a person, alert the team and
  an internal group (tagging the responsible member), put the chat back on Waiting, optionally a
  message to the customer. One alert per escalation; off by default. Built locally on `rudra`;
  not committed, not deployed (`MOOD_DETECTION.md`).
- **Report durations in total hours** (35h 0m, never 1d 11h) and the Team Report's support time is
  now labelled **Support Overtime** (same calculation). **WhatsApp operations can be cleared**
  (finished / ready for review) or hidden (still running) from your own tracker — never a cancel.
  Built locally on `rudra`; not deployed (`REPORTS.md` §11).
- **WhatsApp Chat — one account at a time** (Support → WhatsApp Chat). Built locally on `rudra`;
  not deployed.
  - **Choosing:** pick the WhatsApp account at the top. The list, real counts (All / Waiting /
    categories), search, bulk selection and replies all belong to that account.
  - **Replying:** a reply goes out only from it ("Sending from Primary Account").
  - **Attribution:** each of our messages shows who sent it through the software and from which
    number.
  - **New report:** **WhatsApp Chat User Activity** lists every send by user, account and group, down
    to the message (`WHATSAPP_CHAT_MULTI_ACCOUNT_AUDIT.md`, `REPORTS.md` §10).
- **Support Intelligence reports** (Reports → All Reports → Support Intelligence). Built locally on
  `rudra`; not deployed.
  - **Executive Support Intelligence:** what is happening in support, where the problems are, and
    what changed since the previous period.
  - **Support Cases:** each customer problem with its owner, internal hand-offs, resolution and
    complexity, all inferred and each with its confidence.
  - **Human Response SLA:** how long customers waited for a person; AI and rule replies do not count.
  - **Employee Effectiveness:** an explainable score with every dimension shown. People with too
    little evidence show "Insufficient sample".
  - **Customer Appreciation & Preference:** who customers thanked or praised, and on what evidence.

  Every report also shows **reporting data health**: collection gaps and a verified-from date. The
  inferred figures still need checking against real conversations with the read-only validation
  script (`REPORTS.md` §8–§9).
- **Unanswered Groups & Response Time** (Support → Messages): one row per group where a customer is
  waiting for the Support Team.
  - **Answering:** the group moves to Response Time the moment a Support Team member replies, with
    who replied and how long the customer waited from their first message.
  - **What does not count:** other Teams, the business number, rules and AI.
  - **Clear:** dismisses a wait without touching any message.
  - **Export:** selected rows or everything matching, to Excel.

  Tracked as messages arrive (`SUPPORT_RESPONSE.md`).
- **WhatsApp Message & Media Storage.** The text of every message is always stored. Attachments are
  stored too: images, video, voice notes and audio, documents of any file type, stickers, GIFs and
  other files.
  - **How:** each file is downloaded in the background (never on the message path), verified
    against WhatsApp's own checksum, and kept on a media volume rather than in the database.
  - **In the chat:** files show inline in WhatsApp Chat through an authorised endpoint.
  - **Settings:** each type has its own switch, and all are on by default. Retention is indefinite
    by default; a background, batched cleanup is available with a preview and a typed
    confirmation.
  - **Backups:** the media volume must be backed up separately from the database.

  See `MEDIA_STORAGE.md`.
- **WhatsApp Groups Admin Maker.** Pick a connected account and a number, and a background job
  makes that person an admin in every group where the account is an admin. It never adds anyone:
  - groups where they are not a member are reported, not joined;
  - each promotion is paced and confirmed by reading the admin list back;
  - the job survives the browser closing and pauses visibly if the connection drops.

  See `GROUP_ADMIN_MAKER.md`.
- **Release Notes.** A permanent, publishable changelog — draft, publish, unpublish, archive, with
  a full edit history kept for anything already public. Backfilled with 14 historical releases
  (`packages/db/prisma/seedReleaseNotes.ts`, run once by hand) reconstructed from real, dated
  commits — no version scheme exists in this repo, so only the version numbers are invented; every
  date and every change described traces to an actual commit.
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
