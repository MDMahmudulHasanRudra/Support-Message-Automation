#!/usr/bin/env bash
# Personal (1:1) message collection — READ-ONLY diagnosis. Run on the server, from the checkout.
# Prints counts only: no message text, no phone numbers, no chat ids. Changes nothing, restarts nothing.
cd "${1:-$HOME/Support-Message-Automation}" || exit 1

echo "== 1. Code that is running"
git log -1 --format='%h %ad %s' --date=iso
for c in 3ae4a51 98c0378; do
  git merge-base --is-ancestor "$c" HEAD 2>/dev/null && echo "  $c included" || echo "  $c NOT included"
done
docker compose images worker app

echo "== 2. Worker counters since it started (received/processed; per-kind if the build has them)"
docker compose exec -T worker curl -s http://127.0.0.1:4100/metrics; echo

echo "== 3. Worker log, last 2 hours (counts)"
L=$(docker compose logs --since 2h worker 2>&1)
echo "  live events, group:    $(grep MESSAGE_RECEIVED <<<"$L" | grep -c '"isGroup":true')"
echo "  live events, personal: $(grep MESSAGE_RECEIVED <<<"$L" | grep -c '"isGroup":false')"
echo "  unreadable messages:   $(grep -c 'could not read an incoming message' <<<"$L")"
echo "  reconcile recoveries:  $(grep -c '\[reconcile\] account' <<<"$L")"
echo "  chat-list failures:    $(grep -c 'could not enumerate\|could not list personal chats' <<<"$L")"
echo "  missing-column errors: $(grep -c 'P2022\|does not exist' <<<"$L")"

echo "== 4. Database (counts only)"
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off' <<'SQL'
\echo -- last migration applied
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1;

\echo -- accounts
SELECT label, status, "lastConnectedAt", "lastHeartbeatAt" FROM "WhatsAppAccount" ORDER BY label;

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

\echo -- messages received and NOT stored, per day and reason
SELECT d.day, a.label, d.reason, d.count
FROM "MessageDropCounter" d JOIN "WhatsAppAccount" a ON a.id = d."accountId"
WHERE d.day >= current_date - 7 ORDER BY 1, 2, 3;

\echo -- reconcile sweep: passes that recovered messages the live listener missed, last 24h
SELECT count(*) AS passes, coalesce(sum((metadata->>'recovered')::int), 0) AS recovered
FROM "SystemLog"
WHERE message = 'Recovered messages the live listener did not store'
  AND "createdAt" > (now() AT TIME ZONE 'UTC') - interval '24 hours';

\echo -- personal chats per account, and how many make the first 300 of WhatsApp Chat "All"
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
