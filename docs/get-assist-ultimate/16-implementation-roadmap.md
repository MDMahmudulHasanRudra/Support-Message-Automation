# 16 — Implementation roadmap and backlog

Each line is one work package: one branch off `rudra`, one PR, independently testable and revertible, with the
protocol in the master prompt §24 (inspect → design → implement → verify → review → report). IDs are stable;
order within a phase is the recommended order.

Risk: **L** additive, no runtime path change · **M** changes a runtime path behind a flag/env · **H** touches
WhatsApp sessions, money or tenancy.

## Phase 0 — Audit (this delivery)

| ID | Package | Status |
|---|---|---|
| P0-1 | Verified audit + preservation matrix (`00`) | done |
| P0-2 | Architecture decision (`01`) | recommendation; awaiting decision |
| P0-3 | UI/UX brief (`02`), data model proposal (`05`) | done |
| P0-4 | Baseline script (`scripts/baseline-readonly.sh`) | written; **needs approval to run on the VPS** |
| P0-5 | Fill `15` with measured results | blocked on P0-4 |

## Phase 1 — Reliability foundation

| ID | Package | Risk |
|---|---|---|
| P1-1 | CI: GitHub Actions running typecheck, lint, unit tests, and `test:isolated` for web + worker with a Postgres service — **written, awaiting first run** | L |
| P1-2 | Remove dead `packages/teams-client` reference from `build:packages`; delete the 7 consumerless AI settings fields from the form (columns stay) | L |
| P1-3 | Bind web port to `127.0.0.1` in compose (only after P0-4 confirms Caddy is the only client) | M |
| P1-4 | Scheduled `pg_dump` + media volume backup with retention, and a documented, **rehearsed** restore into the test stack | L |
| P1-5 | Structured logging (pino) with a correlation id carried inbound → automation → outbound → notification | M |
| P1-6 | `/metrics` in Prometheus text (keep JSON at `/metrics.json`); event-loop delay; liveness for the untracked loops; fix billing's stray timer; timeout on Teams webhook POST | L |
| P1-7 | Global security headers (CSP report-only first, frame-ancestors, referrer, nosniff) | M |
| P1-8 | Per-IP rate limit on login, webhooks, and export routes | M |
| P1-9 | `FOR UPDATE SKIP LOCKED` claims on outbound, notification, command and channel queues (identical single-worker behaviour, pinned by existing suites) | M |
| P1-10 | Playwright harness against the isolated stack (login, project switch, chat open, send to a mock provider) | L |
| P1-11 | Domain event outbox table + typed event envelope (`06`), written by nothing yet | L |

## Phase 2 — Unified inbox and Chat UI V3 (flag `CHAT_UI_V3`, off)

P2-1 conversation lifecycle + `ConversationEvent` · P2-2 internal notes · P2-3 assignment to user/team for
both conversation kinds, reusing Support Assignment where it applies · P2-4 channel capability contract ·
P2-5 V3 shell (three panes, responsive) · P2-6 list virtualization + saved views · P2-7 composer modes ·
P2-8 SSE change feed with polling fallback · P2-9 collision indicator ("Rudra is replying"). Each H/M as noted in
its package.

## Phase 3 onward

| Phase | First packages |
|---|---|
| 3 AI Copilot | `AiUsage` cost ledger for **every** AI call (prerequisite) · Assist panel (read-only suggestions with sources) · Draft mode (never sends) · evaluation dataset + runner · Autopilot only as the existing fallback with new policy knobs |
| 4 Website chat | widget as a new `ChannelType`, domain allow-list, signed identity, offline form |
| 5 CRM + Support | `ChannelIdentity` with verification · Customer 360 tab · leads/pipeline · ticket decision record (extend vs new) · customer SLA calendar separate from staff shifts |
| 6 Social | Meta gates B–D first (existing RC); comments only after gate D |
| 7 Commerce | catalog + orders (manual first) · WooCommerce connector · Shopify after a requirements check |
| 8 Delivery | courier adapter; providers only after their API docs are verified |
| 9 Workflow | engine + versioning + dry run, templates before any canvas |
| 10 Integrations | API keys, versioned public API, outbound webhooks on the outbox |
| 11 Hardening | MFA, session/device list, ASVS L2 review, load tests |

## Decisions (Rudra, 29 Oct 2026)

1. Architecture: **Option A approved.** .NET re-evaluated only on measured need.
2. Baseline script: **conditionally approved** — not run on production until the safety report
   (`15` §2.1) is reviewed and the run is explicitly approved.
3. Hosts: `noorvip.getassist.pro` is **not** canonical. Intended: `getassist.pro` site, `admin.getassist.pro`
   platform, `app.getassist.pro` shared entry (verify), `*.getassist.pro` tenants. README to be rewritten from
   verified routing (P1-12); no DNS/Caddy change.
4. Phase 1 starts with CI (P1-1), alongside backup (P1-4) and security (P1-3, P1-7, P1-8).
5. Phase 0 committed to `rudra`.

| ID | Added package | Risk |
|---|---|---|
| P1-12 | README rewrite: Get Assist branding, current architecture, verified domain layout (platform / site / app entry / tenants) | L |
| P1-13 | Seven consumerless AI settings: implement, mark disabled, or remove from the UI — each decided separately, no AI behaviour change without tests | L |
| P1-14 | Move non-session loops (learning, knowledge, Forge, sandbox, billing, Google, email) into a second worker process that holds no browser — needs explicit approval and regression coverage | H |
