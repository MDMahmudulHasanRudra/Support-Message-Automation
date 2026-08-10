# Architecture

Locked in Phase 0. This is the condensed, durable reference; the full review
(with rationale) lives in the Phase 0 plan record.

## Components

- **apps/web** — Next.js dashboard (TS, Tailwind, shadcn/ui in Phase 4). Reads/writes Postgres directly via Prisma (`packages/db`). Runs the rule engine (`packages/engine`) in-process for dry rule tests — no worker call, so a dry test cannot send anything.
- **apps/worker** — dedicated Node/TS process. The **only** process that owns the OpenWA browser session. Runs the message pipeline, the outbound queue processor, the notification dispatcher, and a `WorkerCommand` poller.
- **packages/db** — Prisma schema, migrations, seed, and a `PrismaClient` singleton, imported by both apps.
- **packages/engine** — pure, side-effect-free rule evaluation (matchers, priority resolution, explainable decision trace). One implementation, imported by both apps, so the dashboard's dry tester and the worker's live pipeline can never drift apart. Regex matching is safety-bounded: patterns are validated and rejected at save-time, and evaluated only under a runtime timeout, so no administrator-authored pattern can hang the worker.
- **packages/shared** — enums/types shared by all of the above (message direction, rule status, automation mode, etc.).

## Web ⇄ Worker: no direct HTTP

The dashboard and worker never call each other. All coordination goes through Postgres:

- **Worker → Dashboard**: the worker writes `WhatsAppAccount.status`, `qrCode`, `lastHeartbeatAt` on every state change; the dashboard polls these columns.
- **Dashboard → Worker**: actions needing the live browser session (reconnect, fetch QR, live test send, group resync) are inserted as rows into `WorkerCommand`; the worker polls and executes them.
- **Kill switch**: `AutomationSettings.automationEnabled`, re-read by the worker every processing tick.

This removes an entire class of Docker networking problems, keeps the worker as the sole owner of the OpenWA session, and means every cross-process interaction already has a DB row with a status field (duplicate prevention/idempotency comes largely for free).

## WhatsApp provider abstraction

```ts
interface WhatsAppProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionStatus(): ConnectionStatus;
  getGroups(): Promise<GroupInfo[]>;
  subscribeToMessages(handler: (msg: RawIncomingMessage) => void): void;
  sendMessage(chatId: string, body: string): Promise<SendResult>;
  getAccountInfo(): Promise<AccountInfo>;
}
```

`OpenWAProvider` is the only module allowed to import `@open-wa/wa-automate`. The pipeline, engine, and queue depend only on the interface.

## Persistent session

OpenWA's session/user-data directory is mounted as a **named Docker volume**, so it survives container recreation, not just process restart. **The exact path is verified at runtime in Phase 5, not assumed** — see the Phase 5 acceptance test in the roadmap: connect → restart worker → `docker compose down/up` → confirm no QR re-scan is required.

## Docker services

`postgres` (named volume, healthcheck), `app` (Next.js, standalone build, exposes 3000), `worker` (Chromium-capable image, `shm_size: 1gb`, named `whatsapp_session` volume, **no published port** — its health endpoint binds to `127.0.0.1` for its own `HEALTHCHECK` only).

## Database

See `packages/db/prisma/schema.prisma` for the authoritative model list (added incrementally starting Phase 2): `User`, `WhatsAppAccount`, `WhatsAppGroup`, `InternalTeamMember`, `Message`, `AutomationRule` (unified — one shape for ignore/escalation/auto-reply/last-sender/exception rules), `AutomationExecution`, `OutboundMessage` (DB-backed send queue), `Notification`, `WorkerCommand`, `ProcessingCheckpoint`, `AutomationSettings`, `SystemLog`.

Automation mode is locked to exactly three values (`AutomationSettings.mode`): `MANUAL_ONLY`, `SAFE_AUTO_REPLY` (default), `FULL_RULE_AUTOMATION`.

## High-risk areas

1. OpenWA/Chromium stability inside Docker.
2. Session persistence across container recreation (verified path, not assumed).
3. Outbound queue race conditions — atomic claim + stuck-row recovery sweep required.
4. "Previous/last sender" ordering under non-guaranteed delivery order.
5. Admin-authored regex (ReDoS) — mandatory save-time validation + bounded runtime evaluation.
6. Notification/automation loops (support-group notifications must never re-enter the pipeline).
7. Rule engine correctness under multi-action + priority combinations.
8. Single OpenWA session per worker process (accountId is first-class everywhere to keep multi-account additive later).
9. DB-mediated command polling latency (deliberate simplicity trade-off).

## Roadmap

1. Foundation (this phase) — monorepo, Docker Compose, Prisma bootstrap, health checks.
2. Database & core models.
3. Rule & automation engine (`packages/engine`), including mandatory regex safety.
4. Functional dashboard.
5. OpenWA provider (with the verified-path acceptance test).
6. Message processing & safe automation (pipeline, queue, safety limits).
7. Notification providers (Teams, optional WhatsApp).
8. End-to-end tests.
9. Production hardening.
10. Documentation.
