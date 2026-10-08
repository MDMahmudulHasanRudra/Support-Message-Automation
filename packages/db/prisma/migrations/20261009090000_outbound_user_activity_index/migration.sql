-- DEPLOY NOTE — read before running this against a live database.
--
-- One index on "OutboundMessage"("projectId", "actionType", "createdAt"): the WhatsApp Chat User
-- Activity report reads one project's manual sends (actionType MANUAL_REPLY) over a period
-- (WHATSAPP_CHAT_MULTI_ACCOUNT_AUDIT.md §11). No existing index leads with any of those columns —
-- [chatId, createdAt], [accountId, status, sentAt] and [sentAt] cannot serve it — and the table
-- grows with every auto-reply, so without it the report scans the whole table.
--
-- Prisma runs each migration inside a transaction, so CREATE INDEX CONCURRENTLY is not available
-- here and a plain CREATE INDEX blocks writes to OutboundMessage while it builds. On a busy
-- database, create it by hand first —
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "OutboundMessage_projectId_actionType_createdAt_idx"
--     ON "OutboundMessage"("projectId", "actionType", "createdAt");
--
-- — then mark this migration applied with `prisma migrate resolve --applied
-- 20261009090000_outbound_user_activity_index`. IF NOT EXISTS keeps this file safe either way.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OutboundMessage_projectId_actionType_createdAt_idx" ON "OutboundMessage"("projectId", "actionType", "createdAt");
