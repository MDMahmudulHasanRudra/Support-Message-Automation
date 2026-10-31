#!/usr/bin/env bash
# Performance and deployment baseline — READ-ONLY, run on the server (docs/get-assist-ultimate/15-performance-benchmarks.md).
#
# What it does NOT do: restart, recreate, build or stop any container; touch a WhatsApp session or
# browser; apply a migration; write to the database (the SQL session is read-only, with a statement
# timeout and a lock timeout, before the first query); write any file (output goes to stdout only).
# What it prints: counts, sizes, timings, commit ids, feature keys and migration names. Never message
# text, phone numbers, chat ids, names, emails, environment variables or secrets.
#
# Usage:  bash scripts/baseline-readonly.sh [checkout-dir] [window-days 1-31, default 7]
#         bash scripts/baseline-readonly.sh --sql-only [window-days]   # print the SQL, run nothing
set -u

SQL_ONLY=0
if [ "${1:-}" = "--sql-only" ]; then SQL_ONLY=1; shift; DAYS="${1:-7}"; else DIR="${1:-$HOME/Support-Message-Automation}"; DAYS="${2:-7}"; fi
case "$DAYS" in ''|*[!0-9]*) echo "window-days must be a whole number"; exit 1;; esac
if [ "$DAYS" -lt 1 ] || [ "$DAYS" -gt 31 ]; then echo "window-days must be 1-31"; exit 1; fi

# Every time filter compares a timestamp-WITHOUT-time-zone column (Prisma DateTime, holding UTC) against
# a UTC timestamp, so Postgres can use the column's index. Comparing it with now() (timestamptz) would
# cast the column instead and turn each range into a full scan.
baseline_sql() {
  cat <<SQL
SET default_transaction_read_only = on;
SET statement_timeout = '20s';
SET lock_timeout = '1s';
SET idle_in_transaction_session_timeout = '30s';
SET application_name = 'baseline-readonly';
\\echo '-- size and connections'
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;
SELECT coalesce(state, 'background') AS state, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1 ORDER BY 2 DESC;
SHOW max_connections;
\\echo '-- largest tables (catalog statistics, no scan)'
SELECT relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS total, n_live_tup AS approx_rows
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15;
\\echo '-- migrations: newest three applied, and any unfinished'
SELECT migration_name, finished_at FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 3;
SELECT count(*) AS applied FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT count(*) AS unfinished_or_rolled_back FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
\\echo '-- workload shape'
SELECT count(*) AS projects, count(*) FILTER (WHERE status = 'ACTIVE') AS active_projects FROM "Project";
SELECT status, count(*) AS accounts FROM "WhatsAppAccount" GROUP BY status ORDER BY 2 DESC;
SELECT count(*) FILTER (WHERE "isActive") AS active_groups, count(*) FILTER (WHERE "isMonitored") AS monitored_groups FROM "WhatsAppGroup";
\\echo '-- feature switches stored per project (key, projects on, projects off; absent = catalogue default)'
SELECT key, count(*) FILTER (WHERE enabled) AS on_count, count(*) FILTER (WHERE NOT enabled) AS off_count FROM "ProjectFeature" GROUP BY key ORDER BY key;
\\echo '-- messages per day by WhatsApp timestamp (last ${DAYS} days, UTC)'
SELECT date_trunc('day', "timestampWa")::date AS day, count(*) AS messages
FROM "Message" WHERE "timestampWa" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days' GROUP BY 1 ORDER BY 1;
\\echo '-- inbound latency: WhatsApp timestamp -> stored, seconds (live path: stored within 15 minutes)'
SELECT percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM "createdAt" - "timestampWa")) AS p50_p95_p99, count(*) AS messages
FROM "Message" WHERE "timestampWa" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days'
  AND "createdAt" >= "timestampWa" AND "createdAt" - "timestampWa" < interval '15 minutes';
\\echo '-- message processing failures (last ${DAYS} days)'
SELECT "processingStatus", count(*) FROM "Message" WHERE "timestampWa" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days' GROUP BY 1 ORDER BY 2 DESC;
\\echo '-- queue depth now'
SELECT 'outbound' AS queue, status::text, count(*) FROM "OutboundMessage" WHERE status IN ('PENDING','PROCESSING','RATE_LIMITED') GROUP BY 2
UNION ALL SELECT 'command', status::text, count(*) FROM "WorkerCommand" WHERE status IN ('PENDING','PROCESSING') GROUP BY 2
UNION ALL SELECT 'notification', status::text, count(*) FROM "Notification" WHERE status IN ('PENDING','RETRYING') GROUP BY 2;
\\echo '-- oldest waiting item per queue (age in seconds)'
SELECT 'outbound' AS queue, extract(epoch FROM (now() AT TIME ZONE 'UTC') - min("scheduledAt")) AS oldest_s FROM "OutboundMessage" WHERE status = 'PENDING'
UNION ALL SELECT 'command', extract(epoch FROM (now() AT TIME ZONE 'UTC') - min("createdAt")) FROM "WorkerCommand" WHERE status = 'PENDING'
UNION ALL SELECT 'notification', extract(epoch FROM (now() AT TIME ZONE 'UTC') - min("createdAt")) FROM "Notification" WHERE status = 'PENDING';
\\echo '-- outbound: created -> sent seconds, by send time (last ${DAYS} days)'
SELECT percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM "sentAt" - "createdAt")) AS p50_p95_p99, count(*) AS sent
FROM "OutboundMessage" WHERE "sentAt" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days';
SELECT status, count(*) FROM "OutboundMessage" WHERE "status" IN ('FAILED','CANCELLED','SKIPPED','RATE_LIMITED') AND "updatedAt" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days' GROUP BY status;
\\echo '-- worker commands: created -> started seconds, and failures (last ${DAYS} days)'
SELECT percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM "startedAt" - "createdAt")) AS p50_p95_p99, count(*) AS commands
FROM "WorkerCommand" WHERE "createdAt" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days' AND "startedAt" IS NOT NULL;
SELECT type::text, count(*) AS failed FROM "WorkerCommand" WHERE status = 'FAILED' AND "createdAt" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days' GROUP BY 1 ORDER BY 2 DESC;
\\echo '-- notifications: created -> sent seconds, and failures (last ${DAYS} days)'
SELECT percentile_cont(ARRAY[0.5,0.95]) WITHIN GROUP (ORDER BY extract(epoch FROM "sentAt" - "createdAt")) AS p50_p95, count(*) AS sent
FROM "Notification" WHERE "event" IS NOT NULL AND "createdAt" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days' AND "sentAt" IS NOT NULL;
SELECT count(*) AS failed FROM "Notification" WHERE status = 'FAILED' AND "createdAt" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days';
\\echo '-- collection gaps (last ${DAYS} days)'
SELECT count(*) AS closed_gaps, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM "endedAt" - "startedAt")) AS median_gap_s,
       max(extract(epoch FROM "endedAt" - "startedAt")) AS worst_gap_s
FROM "CollectionGap" WHERE "startedAt" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days' AND "endedAt" IS NOT NULL;
SELECT coalesce("recoveryStatus"::text, 'none') AS recovery, count(*) FROM "CollectionGap" WHERE "startedAt" > (now() AT TIME ZONE 'UTC') - interval '${DAYS} days' GROUP BY 1;
SELECT count(*) AS open_gaps_now FROM "CollectionGap" WHERE "endedAt" IS NULL;
\\echo '-- slow-query indicators'
SELECT count(*) AS pg_stat_statements_installed FROM pg_extension WHERE extname = 'pg_stat_statements';
SELECT count(*) AS queries_running_over_5s FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND now() - query_start > interval '5 seconds';
SELECT relname AS table, seq_scan, idx_scan FROM pg_stat_user_tables WHERE seq_scan > 0 ORDER BY seq_tup_read DESC LIMIT 10;
SQL
}

if [ "$SQL_ONLY" = 1 ]; then baseline_sql; exit 0; fi

cd "$DIR" || { echo "no checkout at $DIR"; exit 1; }
section() { printf '\n== %s\n' "$1"; }
# Bounded docker calls: a wedged daemon or container must not hang the script.
dc() { timeout 60 docker compose "$@"; }

section "1. Host"
echo "  $(date -u +%FT%TZ)   cores: $(nproc)   $(free -m | awk '/^Mem:/ {print "RAM MB total " $2 ", used " $3 ", available " $7}')"
df -h / | awk 'NR==2 {print "  disk /: size " $2 ", used " $3 ", free " $4}'
uptime | sed 's/^/  /'

section "2. Checkout and running containers"
git log -1 --format='  checkout: %h  %ad  %s' --date=iso
echo "  uncommitted files in checkout: $(git status --porcelain | wc -l)"
dc ps --format '  {{.Service}}  {{.Status}}  image={{.Image}}'
dc images --format '  {{.Service}}  created={{.CreatedSince}}' 2>/dev/null || true

section "3. Container resource use (one sample)"
timeout 30 docker stats --no-stream --format '  {{.Name}}  cpu={{.CPUPerc}}  mem={{.MemUsage}}  pids={{.PIDs}}'

section "4. Chromium processes in the worker (counts only; command lines are never printed)"
dc exec -T worker sh -c '
  n=0; rss=0
  for p in /proc/[0-9]*; do
    c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null) || continue
    case "$c" in *chrom*) n=$((n+1)); r=$(awk "/^VmRSS/ {print \$2}" "$p/status" 2>/dev/null); rss=$((rss+${r:-0}));; esac
  done
  echo "  chromium processes: $n   total RSS MB: $((rss/1024))"
  profiles=$(for p in /proc/[0-9]*; do tr "\0" "\n" < "$p/cmdline" 2>/dev/null | grep -- "--user-data-dir=" ; done | sort -u | wc -l)
  echo "  distinct browser profiles running: $profiles"
' 2>/dev/null || echo "  (worker not reachable)"

section "5. Worker metrics (loop liveness and in-memory counters; account ids only)"
dc exec -T worker curl -s --max-time 10 http://127.0.0.1:4100/metrics || echo "  (metrics unreachable)"
echo

section "6. Database (read-only session, 20 s statement timeout, 1 s lock timeout)"
baseline_sql | dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -v ON_ERROR_STOP=0 -P pager=off'

section "7. Exposure"
echo "  listening sockets for 8668 (0.0.0.0 or [::] means reachable from outside unless a firewall blocks it):"
(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk '/:8668 / {print "   " $4}'
echo "  firewall (ufw, if this user can read it without a password):"
(sudo -n ufw status 2>/dev/null || echo "   not readable without a password — check manually") | sed 's/^/   /'
