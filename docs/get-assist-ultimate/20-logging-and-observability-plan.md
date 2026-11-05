# 20 — Structured logging and observability plan (P1-5 + P1-6)

**Status (5 Nov 2026):** plan only. Nothing here is implemented. Each work package below is one branch and one
PR, independently testable and revertible. Read from `rudra` @ `31f1b10`.

**Goal.** When something is slow or wrong, an operator can answer three questions from data rather than from
guesses. Did this customer's message arrive, and where did it stop? Is the server running out of anything? Which
part is slow? It must also be measured well enough to size the 4 vCPU / 16 GB host (doc `00b` §5).

**Rules for every package**
- Reuse what exists (§1) before adding anything. No new service (Prometheus, Grafana, Loki, OpenTelemetry
  collector, Redis) until a measured need names one (§6).
- Logs carry **ids, counts, durations and decisions**. Never message text, phone numbers, chat ids, names,
  emails, tokens, passwords, API keys or secrets.
- The WhatsApp worker's behaviour does not change. Only what it reports does. Every package that ships to the
  worker restarts it on deploy, which reconnects every number for a few minutes. Each such deploy needs Rudra's go-ahead
  and a quiet hour. The rollback is the previous image.
- Production configuration changes (compose, Postgres settings) are separate packages with their own approval.

## 1. What already exists (verified in code)

| Piece | Where | What it gives |
|---|---|---|
| Worker `/health`, `/metrics` (JSON, 127.0.0.1 only) | `apps/worker/src/health/server.ts` | DB connectivity (the 200/503 decision), uptime, counters, every loop's last tick, collection by kind |
| In-memory counters | `health/metrics.ts` | received / processed / failed / retried / replied / collectionBreaks / identityUnattributed, per process |
| Loop liveness | `health/loopLiveness.ts` | Last finished tick of each loop; published every 15 s |
| `WorkerHealthSnapshot` (one row) | heartbeat in `apps/worker/src/index.ts` | Loop liveness in the database, so the web can read it |
| Platform → Monitoring | `apps/web/src/server/platform/monitoring.ts` | Heartbeat age, stalled loops, outbound pending, failed sends / notifications / commands (24 h), open collection gaps, accounts by state |
| Collection watchdog + `CollectionGap` | `health/collectionWatchdog.ts`, `collectionGaps.ts` | Proof that a period was collected completely |
| Event-loop delay + load | `commands/groupRecovery.ts` `readMachineLoad()` | `monitorEventLoopDelay` p99 and `loadavg` per CPU, used only by group recovery today |
| Chromium processes by profile | `provider/openwa/orphanBrowsers.ts` | Reads `/proc/*/cmdline` to find each account's browser |
| `SystemLog` with `correlationId` (indexed) | both apps' `logSystemEvent` | Durable, project-scoped events with actor/target/correlation |
| Pipeline trace | `pipeline/processIncomingMessage.ts` `traceStage()` | `[pipeline] [<account>:<waMessageId>] STAGE {…}` on stdout |
| Rows that already link a message's journey | `Message` → `AutomationExecution.messageId` → `AiFallbackDecision.messageId` (`latencyMs`, `tokensUsed`) → `OutboundMessage.relatedMessageId` (`scheduledAt`, `sentAt`, `attemptCount`) → `Notification.relatedMessageId` | A complete, timestamped trace, **already stored**, keyed by the incoming `Message.id` |
| Baseline SQL (read-only) | `scripts/baseline-readonly.sh` | Inbound latency p50/p95/p99, queue depth and age, DB size, connections |

Logging today: about 248 `console.*` calls in the worker, 59 in the web and 29 in packages. The runbook
(`INCIDENT_RUNBOOK.md` §2) greps for `[watchdog]`, `[registry]`, `[catch-up]`, `[openwa]` and `[queue]` prefixes.
**Any format change must keep those greps working.**

## 2. Findings that shape the plan

| # | Finding | Evidence | Why it matters |
|---|---|---|---|
| F1 | **Every incoming message writes the sender's phone, the chat id and the first 80 characters of its text to the worker's stdout.** | `processIncomingMessage.ts:106-111` (`MESSAGE_NORMALIZED`: `senderPhone`, `chatId`, `bodyPreview`); `:101` (`OWN_ACCOUNT_MESSAGE`: `senderPhone`) | Customer content in plain logs, against the rule above and `logSystemEvent`'s own warning. It is kept indefinitely (F2) |
| F2 | No log rotation on any container | `docker-compose.yml` has no `logging:` block | Docker's default `json-file` grows without limit on the disk Postgres uses, and keeps F1's content |
| F3 | The trace id stops at the AI fallback | `traceId` = `<accountId>:<waMessageId>`, passed only to `runAiFallback` | The outbound queue, notifications and the channel paths log without it |
| F4 | `/metrics` is in memory and JSON only; nothing outside the container reads it | `server.ts` binds 127.0.0.1 | Fine for an incident, useless for trends. No history survives a restart |
| F5 | No process figures anywhere: RSS, heap, event-loop delay, Chromium memory, disk free | — | The 16 GB sizing question cannot be answered |
| F6 | No database figures: connections in use vs 100, longest query, size growth | — | The pool bounds (10 per process) cannot be checked against reality |
| F7 | A failed backup tells nobody | doc `19` §7 | P1-4's last open item |

## 3. Work packages

Order is the recommended order. **L** = additive, no runtime path change. **M** = changes what a running process
does, behind a default that keeps today's behaviour.

### O1 — Remove customer content from logs (P1-5) · L · worker only

- `traceStage` keeps ids, booleans, decisions and lengths: `chatKind` (group / personal), `bodyLength`, and
  `hasMedia` in place of `chatId`, `senderPhone` and `bodyPreview`. `OWN_ACCOUNT_MESSAGE` drops `senderPhone`.
- Review the other ~336 `console.*` calls for message text, phones, emails and secrets, and fix any found. A
  keyword grep while writing this plan found no other case. It is not a full review, and O1 does that.
- **Test:** a pipeline unit test captures `console.log` while a message with a known body and phone runs
  through, and asserts that neither string appears. It must fail on today's code.
- **Rollback:** revert. **Note:** old logs keep what they hold until rotated (O2) or the container is recreated.

### O2 — Log rotation (P1-5) · production config · needs approval

- Add `logging: { driver: json-file, options: { max-size: "50m", max-file: "5" } }` to every service in
  `docker-compose.yml`: at most about 250 MB per container.
- It takes effect only when containers are recreated. Schedule it with the next deploy, never as its own worker
  restart.
- **Rollback:** remove the block and recreate.

### O3 — One small logger, greppable by default (P1-5) · L

- `packages/shared/src/log.ts` (pure, no dependency) provides `log(level, scope, event, fields?)`. It writes one
  line: `[scope] EVENT key=value …` by default, which keeps every runbook grep working, or one JSON object per line
  when `LOG_FORMAT=json`.
- **Redaction by key, enforced in the logger:** values under `body`, `text`, `content`, `phone`, `email`,
  `token`, `password`, `secret`, `apiKey`, `authorization` or `cookie` are replaced with `[redacted]`, whatever
  the caller passes. That is a backstop, not permission to pass them.
- No `pino` dependency: line-per-event to stdout needs none. Revisit only if O8 chooses a collector that needs
  something else.
- Adopt by area, one PR each: pipeline (`traceStage`), outbound queue, notification dispatcher, command
  processor. All other `console.*` stay until their area is touched.
- **Test:** formatter and redaction unit tests in `packages/shared`.

### O4 — One correlation id along the whole path (P1-5) · L

- The correlation id is the incoming **`Message.id`**, because the rows already link on it (§1). No new column.
  The pipeline logs it from `MESSAGE_PERSISTED` onward (with the WhatsApp id before that). The outbound queue
  logs `relatedMessageId`, the notification dispatcher its `relatedMessageId`, and `logSystemEvent` callers on
  those paths pass it as `correlationId`.
- **Message timeline** on the existing message page (`messages/[id]`), read-only, from rows only:
  - received (WhatsApp time) → stored → rule decision → AI decision (with `latencyMs`) → reply queued →
    sent (with attempts) → echo stored;
  - each step's duration, and where it stopped.

  This answers "where did this message stop?" without reading any log.
- **Tests:** a page-loader test over seeded rows. Project isolation is covered by the existing scoped client and
  `projectReports` tests (a timeline for another project's message is a 404).

### O5 — Process figures from the worker (P1-6) · L (no restart beyond the deploy)

- `health/processStats.ts` collects, every 15 s on the existing heartbeat:
  - RSS and heap, plus event-loop delay p50 / p99 (`monitorEventLoopDelay`, moved here from group recovery,
    which then reads it from here);
  - load per CPU;
  - **Chromium RSS per account**, summed over its process tree, found through the same `/proc` scan as
    `orphanBrowsers`;
  - free disk under `MEDIA_STORAGE_DIR` and the session directory (`statfs`).
- Served on `/metrics`. Published to `WorkerHealthSnapshot` in one **new JSON column `process`** (an additive
  migration with no backfill, like `loops`). Account ids only, no labels or numbers.
- **Platform → Monitoring** shows these with plain thresholds, for example "disk below 15 % free", "event-loop p99
  above 200 ms" and "an account's browser above 1.5 GB". Each threshold is a stated number in code, to be adjusted
  after a week of real readings, never presented as a measurement.
- **Tests:** collectors are unit-tested against fixture `/proc` trees, and `monitoring.ts` gets a reader test.
  Missing `/proc` (Windows, macOS) reads as "unavailable", never as zero.

### O6 — Message and queue latency from rows (P1-6) · L · web only

- Platform → Monitoring gets read-only figures, computed on request over the last 24 h:
  - inbound latency p50 / p95 / p99 (`Message.createdAt − timestampWa`, the baseline script's definition, live
    path only);
  - outbound delay p50 / p95 (`sentAt − scheduledAt`, SENT rows), and the oldest waiting row per queue (outbound,
    notifications, commands, channel, email, social);
  - failures per queue (24 h), extending the counts the page already has.
- Per customer, the same figures go on the existing customer health view.
- Every query is bounded by time on an indexed column. Any raw SQL names `"projectId"` or goes through the
  platform reader, as `rawSqlProjectFilter` requires. **Check each query plan against a copy of production data
  before merge**: the rehearsal machine from doc 19 is the place.

### O7 — Database figures (P1-6) · L · read-only

- From `pg_stat_activity` and `pg_database_size`, no extension: connections by state against `max_connections`,
  the oldest running query's age (no SQL text), idle-in-transaction count, database size, and the largest tables
  (catalog statistics, no scan).
- **Deferred to O9:** `pg_stat_statements` (slow queries by shape). It needs `shared_preload_libraries` and a
  Postgres restart.

### O8 — Keep history and decide on a collector · decision first

- Decide whether trends live in an external collector (Prometheus or an uptime service reading
  `/metrics.prom`) or in Postgres. One option is a `ProcessSample` row per 5 minutes with 30-day retention
  (about 8,600 rows).
- Recommendation: start with the Postgres option. It needs nothing new on the host, and Platform → Monitoring can
  draw the last 30 days with the existing SVG charts. Move to Prometheus only if O5–O7 show a need for
  finer-grained or longer history.
- **Needs a decision from Rudra before any code.**

### O9 — `pg_stat_statements` · production config · needs approval

- Add `shared_preload_libraries=pg_stat_statements` to the compose `postgres` command and
  `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` in a migration. Platform → Monitoring then lists the top
  queries by total time, by shape only.
- It restarts Postgres, so app and worker reconnect. Do it in the same window as O2.
- **Rollback:** remove the flag and restart; the extension is harmless if left.

### O10 — Backup status and operator alerts (closes P1-4's last item) · L + small migration

- `backup.sh` records each run's result (time, OK/FAILED, sizes, no paths) in a platform table `BackupRun`
  through `docker compose exec postgres psql`. One insert per run.
- Platform → Monitoring shows the last successful backup.
- A worker loop (every 5 min, overlap-guarded) emails platform operators through the existing `platformMailer()`.
  Triggers:
  - no successful backup in 26 h;
  - disk under the threshold;
  - heartbeat stale (sent by the web side, since a dead worker cannot report itself);
  - a loop stalled for 10 minutes.

  Each alert fires once per condition and again when it clears.
- **Tests:** a trigger and de-duplication unit test, plus a backup-script case for the insert.

## 4. What this measures, mapped to the request

| Wanted | Package | Source |
|---|---|---|
| CPU and RAM | O5 | `loadavg`, process RSS / heap |
| Chromium memory per account | O5 | `/proc` process tree per profile |
| Event-loop delay | O5 | `monitorEventLoopDelay` |
| Incoming message latency | O6 | `Message.createdAt − timestampWa` |
| Outbound queue delay | O6 | `OutboundMessage.sentAt − scheduledAt`, oldest waiting |
| Database query time | O7 now (oldest running query), O9 (by shape) | `pg_stat_activity`, `pg_stat_statements` |
| Background job failures | O6 | Failed rows per queue, 24 h; stalled loops (existing) |
| Backup success / failure | O10 | `BackupRun` |
| Disk space | O5 (+ O10 alert) | `statfs` on the media and session paths |
| One message's journey | O4 | Rows, by `Message.id` |

Not covered by any package: Postgres's own RSS, and the host's total memory beyond `loadavg`. The worker
cannot see other containers. Read them with `docker stats` (the baseline script already does), or add a host
agent later if O8 chooses one.

## 5. Order and dependencies

```
O1 ─┐
O3 ─┼─> O4                (logging)
O5 ─┼─> O8 (decision) ─> history
O6 ─┤
O7 ─┘
O2 + O9: one approved maintenance window (compose + Postgres restart), alongside a normal deploy
O10 after P1-4's branch is merged
```

Smallest useful first step: **O1** (stops customer content reaching logs). It is a few lines in one file plus a
test, and it ships with the next worker deploy.

## 6. Explicitly not now

- OpenTelemetry tracing: the rows already are the trace (O4). Revisit when there is more than one worker process
  (P1-14).
- A metrics or log stack (Prometheus, Grafana, Loki, ELK): only after O8's decision and a named need.
- Per-request web tracing: the web has no slow-request evidence yet. O7 and O9 will show slow queries first.
- Changing any alert or threshold the WhatsApp pipeline acts on. This plan only reports.
