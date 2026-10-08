-- DEPLOY NOTE — read before running this against a live database.
--
-- One index on "OutboundMessage"("providerMessageId"): Support Intelligence joins each outgoing
-- Message to the OutboundMessage it echoes, to tell a person's reply from an AI or rule reply
-- (Human Response SLA, SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md §H M3). Without it that join
-- scans the table.
--
-- Prisma runs each migration inside a transaction, so CREATE INDEX CONCURRENTLY is not available
-- here and a plain CREATE INDEX blocks writes to OutboundMessage while it builds. On a busy
-- database, create it by hand first —
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "OutboundMessage_providerMessageId_idx"
--     ON "OutboundMessage"("providerMessageId");
--
-- — then mark this migration applied with `prisma migrate resolve --applied
-- 20261008090000_outbound_provider_message_index`. IF NOT EXISTS keeps this file safe either way.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OutboundMessage_providerMessageId_idx" ON "OutboundMessage"("providerMessageId");
