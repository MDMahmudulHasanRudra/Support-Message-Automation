-- DEPLOY NOTE — read before running this against a live database.
--
-- Two of these five indexes target "Message" and "OutboundMessage", the largest tables in this
-- system. A plain CREATE INDEX holds a lock that blocks WRITES for as long as the build takes, and
-- Prisma wraps each migration in a transaction, so CREATE INDEX CONCURRENTLY — which cannot run
-- inside one — is not available from here. Same situation as
-- 20260902091844_knowledge_sources_and_query_indexes, and the same escape hatch:
--
--   On a busy database, create those two by hand first, outside a transaction:
--     CREATE INDEX CONCURRENTLY "Message_accountId_timestampWa_idx" ON "Message"("accountId", "timestampWa");
--     CREATE INDEX CONCURRENTLY "OutboundMessage_chatId_createdAt_idx" ON "OutboundMessage"("chatId", "createdAt");
--   then run the rest by marking this applied:
--     npx prisma migrate resolve --applied 20260918110000_reliability_query_indexes
--   (having first created the three small-table indexes below by hand as well, since resolving
--   marks the WHOLE migration applied without executing any of it).
--
-- The other three are on small tables and are a non-event either way.
--
-- Every index here fixes a read that was a sequential scan or a discard-everything index walk.
-- None of them changes a result: each is purely an access path for a query that already exists.

-- The collection watchdog's own question — "the newest message this account stored" — and the
-- Overview entry that asks it per account. Without this it is a backward walk of the global
-- [timestampWa] index throwing away every row belonging to a different account, which is slowest
-- exactly when an account has been silent longest. The check meant to find an outage got slower
-- the worse the outage was.
-- CreateIndex
CREATE INDEX "Message_accountId_timestampWa_idx" ON "Message"("accountId", "timestampWa");

-- The chat inbox polls every four seconds and asks two questions per poll that both begin "the
-- newest outbound rows for these chats". "chatId" carried no index at all, so each was a full
-- sequential scan of a table that only grows.
-- CreateIndex
CREATE INDEX "OutboundMessage_chatId_createdAt_idx" ON "OutboundMessage"("chatId", "createdAt");

-- Every existing SupportActivity index leads with "accountId" and no dashboard caller filters on
-- it — the reports are deployment-wide, not per-number — so the whole module read by sequential
-- scan. These are the two shapes those reports actually use.
-- CreateIndex
CREATE INDEX "SupportActivity_occurredAt_idx" ON "SupportActivity"("occurredAt");

-- CreateIndex
CREATE INDEX "SupportActivity_actor_occurredAt_idx" ON "SupportActivity"("actor", "occurredAt");

-- linkClosedSessionsToCandidates asks "which of these sessions has no evidence row yet" — an
-- anti-join on conversationSessionId. The compound unique leads with patternCandidateId and
-- cannot serve it, so that ran as a scan every fifteen minutes.
-- CreateIndex
CREATE INDEX "PatternCandidateEvidence_conversationSessionId_idx" ON "PatternCandidateEvidence"("conversationSessionId");

-- "Every monitored, active group", with no account filter: what the rewritten awaiting-reply
-- query drives its LATERAL from, on both Overview and Team Performance.
-- CreateIndex
CREATE INDEX "WhatsAppGroup_isMonitored_isActive_idx" ON "WhatsAppGroup"("isMonitored", "isActive");
