#!/usr/bin/env bash
# Personal (1:1) message collection — READ-ONLY diagnosis, run on the server (PERSONAL_MESSAGES_RUNBOOK.md).
#
# What it does NOT do: restart, recreate or build any container; touch a WhatsApp session; apply a
# migration; write to the database (the SQL session is set read-only before the first query).
# What it prints: counts, commit ids, timestamps, account labels and account ids. Never message text,
# phone numbers, chat ids or secrets — log lines are counted by a single streaming awk pass and never
# echoed, so a large log is never held in memory either.
#
# Usage:  bash scripts/diagnose-personal-messages.sh [checkout-dir] [log-window, default 2h]
set -u
DIR="${1:-$HOME/Support-Message-Automation}"
WINDOW="${2:-2h}"
cd "$DIR" || { echo "no checkout at $DIR"; exit 1; }

section() { printf '\n== %s\n' "$1"; }

section "1. Server checkout (the code on disk — NOT necessarily what is running)"
git log -1 --format='  %h  %ad  %s' --date=iso
echo "  branch: $(git rev-parse --abbrev-ref HEAD)   uncommitted files: $(git status --porcelain | wc -l)"

section "2. What is actually RUNNING (fingerprints inside the containers)"
for svc in worker app; do
  cid=$(docker compose ps -q "$svc" 2>/dev/null)
  if [ -z "$cid" ]; then echo "  $svc: not running"; continue; fi
  echo "  $svc: image created $(docker inspect -f '{{.Created}}' "$(docker inspect -f '{{.Image}}' "$cid")" | cut -c1-19)   container started $(docker inspect -f '{{.State.StartedAt}}' "$cid" | cut -c1-19)"
done
# Each marker is a name that exists only from that commit on, so its presence dates the running build.
worker_has() { docker compose exec -T worker sh -c "grep -rqs -- '$1' /app/apps/worker/dist" && echo "yes" || echo "NO"; }
echo "  worker 510343b link loading waits for chats ............ $(worker_has 'link-pending')"
echo "  worker 3ae4a51 personal chats read back by recovery ..... $(worker_has 'listActivePersonalChats')"
echo "  worker 98c0378 handlers wired before connect ............ $(worker_has 'isFreshOperatorRestart')"
echo "  worker 36ccf91 personal-message hotfix .................. $(worker_has 'awaitDecryption')"
app_has() { docker compose exec -T app sh -c "grep -rqs -- '$1' /app/apps/web/.next/server" && echo "yes" || echo "NO"; }
echo "  app    36ccf91 personal chats kept in 'All' ............. $(app_has 'kindRank')"

section "2b. Container memory limits: running vs. the checkout's compose file (0 = unlimited)"
for svc in worker app postgres; do
  cid=$(docker compose ps -q "$svc" 2>/dev/null)
  [ -n "$cid" ] && echo "  $svc running: memory=$(docker inspect -f '{{.HostConfig.Memory}}' "$cid") shm=$(docker inspect -f '{{.HostConfig.ShmSize}}' "$cid")"
done
# Only these two keys are printed: the rest of `docker compose config` holds resolved secrets.
echo "  checkout compose file:"; docker compose config 2>/dev/null | grep -E '^\s*(mem_limit|shm_size|memory):' | sed 's/^/   /'

section "3. Database migrations (read-only comparison; nothing is applied)"
psql_ro() { docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -v ON_ERROR_STOP=0 -P pager=off "$@"' sh "$@"; }
applied=$(printf 'SET default_transaction_read_only = on;\nSELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;\n' | psql_ro -At | LC_ALL=C sort)
broken=$(printf 'SET default_transaction_read_only = on;\nSELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;\n' | psql_ro -At)
image_dirs=$(docker compose exec -T worker sh -c 'ls /app/packages/db/prisma/migrations' 2>/dev/null | tr -d '\r' | grep -v '\.toml$' | LC_ALL=C sort)
disk_dirs=$(ls packages/db/prisma/migrations | grep -v '\.toml$' | LC_ALL=C sort)
echo "  applied: $(printf '%s\n' "$applied" | grep -c .)   last: $(printf '%s\n' "$applied" | tail -1)"
echo "  failed or rolled-back rows: ${broken:-?}"
echo "  in the RUNNING worker image but not applied: $(comm -23 <(printf '%s\n' "$image_dirs") <(printf '%s\n' "$applied") | grep -c .)"
comm -23 <(printf '%s\n' "$image_dirs") <(printf '%s\n' "$applied") | sed 's/^/    /'
echo "  in the server CHECKOUT but not applied: $(comm -23 <(printf '%s\n' "$disk_dirs") <(printf '%s\n' "$applied") | grep -c .)"
comm -23 <(printf '%s\n' "$disk_dirs") <(printf '%s\n' "$applied") | sed 's/^/    /'

section "4. Worker counters since it started (per account; per kind when the build has 36ccf91)"
docker compose exec -T worker curl -s --max-time 10 http://127.0.0.1:4100/metrics || echo "  (metrics unreachable)"
echo

section "5. Worker log, last $WINDOW (counted in one streaming pass, nothing echoed)"
docker compose logs --since "$WINDOW" --no-color worker 2>&1 | awk '
  /MESSAGE_RECEIVED/ { if (/"isGroup":true/) g++; else if (/"isGroup":false/) p++ }
  /could not read an incoming message/ { unreadable++ }
  /\[reconcile\] account .*recovered/ { reconcile++ }
  /incomplete read/ { incomplete++ }
  /could not enumerate|could not list personal chats/ { listfail++ }
  /still encrypted after/ { gaveup++ }
  /P2022|does not exist/ { p2022++ }
  END {
    printf "  live events, group: %d   personal: %d\n", g, p
    printf "  unreadable messages: %d   undecrypted given up: %d\n", unreadable, gaveup
    printf "  reconcile passes that recovered something: %d   incomplete reads: %d\n", reconcile, incomplete
    printf "  chat-list failures: %d   missing-column (P2022) errors: %d\n", listfail, p2022
  }'

section "6. Database (counts only)"
psql_ro <<'SQL'
SET default_transaction_read_only = on;
\echo -- accounts and their group-sync state
SELECT id AS account_id, label, status, "lastConnectedAt", "groupSyncStatus", "groupSyncDiscovered", "groupSyncCompletedAt"
FROM "WhatsAppAccount" ORDER BY label;

\echo -- incoming, last 24h: stored live (< 2 min after sending) vs late (recovered), per account and kind
SELECT a.label,
  CASE WHEN m."groupId" IS NOT NULL THEN 'group'
       WHEN m."chatId" LIKE '%@c.us' OR m."chatId" LIKE '%@lid' THEN 'personal'
       ELSE 'other:' || split_part(m."chatId", '@', 2) END AS kind,
  count(*) AS total,
  count(*) FILTER (WHERE m."createdAt" - m."timestampWa" <  interval '2 minutes') AS live,
  count(*) FILTER (WHERE m."createdAt" - m."timestampWa" >= interval '2 minutes') AS late
FROM "Message" m JOIN "WhatsAppAccount" a ON a.id = m."accountId"
WHERE m.direction = 'INCOMING' AND m."timestampWa" > (now() AT TIME ZONE 'UTC') - interval '24 hours'
GROUP BY 1, 2 ORDER BY 1, 2;

\echo -- personal messages per day, last 7 days (a sudden drop dates the problem)
SELECT (m."timestampWa" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka')::date AS dhaka_day, a.label,
  count(*) FILTER (WHERE m.direction = 'INCOMING') AS incoming, count(*) FILTER (WHERE m.direction = 'OUTGOING') AS outgoing
FROM "Message" m JOIN "WhatsAppAccount" a ON a.id = m."accountId"
WHERE m."groupId" IS NULL AND (m."chatId" LIKE '%@c.us' OR m."chatId" LIKE '%@lid')
  AND m."timestampWa" > (now() AT TIME ZONE 'UTC') - interval '7 days'
GROUP BY 1, 2 ORDER BY 1, 2;

\echo -- messages received and NOT stored, per day and reason
SELECT d.day, a.label, d.reason, d.count
FROM "MessageDropCounter" d JOIN "WhatsAppAccount" a ON a.id = d."accountId"
WHERE d.day >= current_date - 7 ORDER BY 1, 2, 3;

\echo -- reconcile sweep: passes that recovered messages the live listener missed, last 24h
SELECT count(*) AS passes, coalesce(sum((metadata->>'recovered')::int), 0) AS recovered
FROM "SystemLog"
WHERE message = 'Recovered messages the live listener did not store'
  AND "createdAt" > (now() AT TIME ZONE 'UTC') - interval '24 hours';

\echo -- personal chats per account, and how many make the first 300 of WhatsApp Chat "All" (before 36ccf91)
WITH conv AS (
  SELECT m."accountId", m."chatId", 'personal' AS kind, max(m."timestampWa") AS last_at
  FROM "Message" m
  WHERE m."groupId" IS NULL AND (m."chatId" LIKE '%@c.us' OR m."chatId" LIKE '%@lid')
  GROUP BY 1, 2
  UNION ALL
  SELECT g."accountId", g."whatsappGroupId", 'group', l."timestampWa"
  FROM "WhatsAppGroup" g
  LEFT JOIN LATERAL (SELECT m."timestampWa" FROM "Message" m WHERE m."groupId" = g."id"
                     ORDER BY m."timestampWa" DESC LIMIT 1) l ON true
  WHERE g."isActive" AND g."chatArchivedAt" IS NULL
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY "accountId" ORDER BY last_at DESC NULLS LAST) AS rnk FROM conv
)
SELECT a.label, r.kind, count(*) AS conversations, count(*) FILTER (WHERE r.rnk <= 300) AS in_all_top_300
FROM ranked r JOIN "WhatsAppAccount" a ON a.id = r."accountId"
GROUP BY 1, 2 ORDER BY 1, 2;
SQL
echo
echo "Done. Nothing was changed."
