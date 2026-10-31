# 15 — Performance baseline

**Status:** method and tooling ready; **no measurements taken yet.** No number in this repository about current
production performance should be trusted until the table in §3 is filled from a real run.

## 1. Why nothing is measured yet

The prompt forbids touching production without explicit authorisation, and the local machine shares nothing with
production load. The baseline therefore needs one approved, read-only run on the production VPS.

## 2. The script

`scripts/baseline-readonly.sh` — same safety shape as `scripts/diagnose-personal-messages.sh`:

- Every SQL statement runs after `SET default_transaction_read_only = on`.
- No container is restarted, rebuilt or recreated; no WhatsApp session is touched; no migration is run.
- It prints counts, sizes, timings and ids only — never message text, phone numbers, chat ids or names.

```bash
cd ~/Support-Message-Automation
bash scripts/baseline-readonly.sh ~/Support-Message-Automation 7 > ~/baseline-$(date +%F).txt
```

Per the owner's decision it runs **once, at a low-traffic hour, only after explicit approval**.

### 2.1 Safety report (every command the script executes)

| # | Command | Effect | Risk |
|---|---|---|---|
| 1 | `date`, `nproc`, `free`, `df`, `uptime` | read host counters | none |
| 2 | `git log -1`, `git status --porcelain \| wc -l` | read the checkout; prints commit + a count | none (no file written; `git status` may refresh the index stat cache, which is not content) |
| 2 | `docker compose ps`, `docker compose images` | list containers/images | none — read-only Docker API |
| 3 | `docker stats --no-stream` | one resource sample | none |
| 4 | `docker compose exec -T worker sh -c '…'` | reads `/proc/*/cmdline` and `/proc/*/status` **inside** the worker; prints only two counts and a sum | none — no signal sent, no file written; command lines never printed (they hold profile paths) |
| 5 | `docker compose exec -T worker curl …/metrics` | the same loopback endpoint the health check uses | none; output holds account ids and counters, no names/numbers/text |
| 6 | `docker compose exec -T postgres psql` + SQL below | read-only queries | see below |
| 7 | `ss -ltn`, `sudo -n ufw status` | list listening sockets / firewall | none; `sudo -n` never prompts and fails if a password is needed |

Every `docker compose` call is wrapped in `timeout 60` (`docker stats` in `timeout 30`). Nothing is restarted,
stopped, built, pulled or recreated; no WhatsApp session or browser is signalled.

**Database safety:**
- First statements: `default_transaction_read_only = on`, `statement_timeout = 20s`, `lock_timeout = 1s`,
  `idle_in_transaction_session_timeout = 30s`, `application_name = baseline-readonly` (visible in `pg_stat_activity`
  so it can be identified and cancelled).
- Every query is a `SELECT`, `SHOW` or `\echo`; a write would be refused by the read-only session.
- Plain `SELECT`s take only `ACCESS SHARE` locks, which block nothing except `DROP`/`ALTER`/`VACUUM FULL`.
- Size figures come from catalog functions and `pg_stat_user_tables` (no table scan).
- Time-ranged queries hit indexed columns: `Message.timestampWa`, `OutboundMessage.sentAt`,
  `OutboundMessage(status, scheduledAt)`, `WorkerCommand(status, createdAt)`, `Notification(event, createdAt)`,
  `CollectionGap(projectId, startedAt)`. Ranges compare against `now() AT TIME ZONE 'UTC'` so the index stays
  usable on these `timestamp without time zone` columns. The window is capped at 31 days.
- The only possibly unindexed scan is the `OutboundMessage` failure count filtered by `updatedAt` (bounded by the
  20 s timeout; it reads `status`/`updatedAt` only).
- Output: counts, percentiles, sizes, migration names, feature keys. No column holding message text, phone, chat id,
  name, email, token or secret is selected. No environment variable is printed (`$POSTGRES_USER`/`$POSTGRES_DB` are
  expanded inside the container and never echoed).

**Files:** the script writes nothing. Output goes to stdout; the operator chooses where to redirect it.

**Validation done:** `bash -n` syntax check; schema check of every column and enum value referenced.
**Not done (Rudra to run):** executing the SQL against the isolated test DB:

```bash
docker compose -f docker-compose.test.yml up -d --wait
bash scripts/baseline-readonly.sh --sql-only 7 | docker compose -f docker-compose.test.yml exec -T postgres-test psql -U support_automation_test -d support_automation_test -X -v ON_ERROR_STOP=1
docker compose -f docker-compose.test.yml down -v
```

Expect every query to return (mostly zero rows on an empty DB) and no `ERROR` line.

**Proposed production command (only after approval, low-traffic hour).** The server checkout is **not** pulled —
that would change production files. Only the reviewed script is copied to the operator's home directory:

```bash
# from the workstation
scp scripts/baseline-readonly.sh <user>@<vps>:~/baseline-readonly.sh
# on the VPS
nice -n 19 bash ~/baseline-readonly.sh ~/Support-Message-Automation 7 > ~/baseline-$(date +%F-%H%M).txt 2>&1
rm ~/baseline-readonly.sh
```

Then share the file; findings are copied, sanitised, into §3.

What it captures:

| Section | Metric |
|---|---|
| 1 | Host cores, RAM, disk, load |
| 2 | Checkout commit, container status and image age (answers "is the running image the checkout?") |
| 3 | `docker stats` CPU / memory per container |
| 4 | Chromium process count, total Chromium RSS, distinct profiles (≈ linked accounts with a live browser) |
| 5 | Worker `/metrics`: loop liveness and in-memory counters |
| 6 | DB size, connections by state, largest tables, last applied migration, unfinished migrations, projects, accounts by status, active/monitored groups, messages/day, inbound latency p50/95/99, outbound queue delay p50/95/99 and status mix, command wait, notification delay, collection gaps and recovery outcomes, whether `pg_stat_statements` exists |
| 7 | Whether port 8668 listens on all interfaces, firewall state |

## 3. Results

| Metric | Busy-hour run | Quiet-hour run |
|---|---|---|
| Linked accounts / Chromium RSS per account | — | — |
| Worker RSS, CPU | — | — |
| App RSS, CPU | — | — |
| DB size, peak connections | — | — |
| Messages per day (7-day range) | — | — |
| Inbound latency p50 / p95 / p99 | — | — |
| Outbound delay p50 / p95 / p99 | — | — |
| Command wait p50 / p95 | — | — |
| Median / worst collection gap | — | — |

## 4. Not covered by the script (needs additive code, Phase 1)

- **Event-loop delay** of the worker: add `perf_hooks.monitorEventLoopDelay()` to `/metrics`.
- **Page/API latency**: Caddy access log with durations, or a timing wrapper around server actions.
- **Slow queries**: enable `pg_stat_statements` (a config change, needs approval and a Postgres restart).

## 5. Load testing

No load test is run against production. Phase 1 adds a k6 (or autocannon) scenario against the isolated stack for
inbox polling and report pages, with a synthetic message generator writing directly to the test DB.
