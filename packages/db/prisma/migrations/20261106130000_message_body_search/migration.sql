-- DEPLOY NOTE — read before running this against a live database.
--
-- Inbox V3 WhatsApp message search (V3-06, Option A): one trigram GIN index on "Message"."body", so a search
-- finds a substring anywhere in the WHOLE history — Bengali, Banglish and English alike (pg_trgm keeps Bengali
-- words whole under this database's en_US.utf8 ctype; checked on postgres:16-alpine). Only the Inbox V3 search
-- reads it (apps/web/src/server/whatsAppMessageSearch.ts), and only for projects with UNIFIED_INBOX_V3 on; it
-- changes no row and no result anywhere else.
--
-- pg_trgm ships with the official postgres image and is a trusted extension, so the database owner can create
-- it. It creates functions and operator classes only, no tables.
--
-- "Message" is the largest table here. Prisma runs each migration inside a transaction, so CREATE INDEX
-- CONCURRENTLY is not available from this file, and the plain CREATE INDEX below holds a lock that BLOCKS
-- WRITES to "Message" (the worker stores every incoming message there) for the whole build. On a live
-- database, build it by hand first, outside a transaction:
--
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
--   SET maintenance_work_mem = '512MB';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_body_search_idx" ON "Message" USING gin ("body" gin_trgm_ops);
--
-- then confirm it finished VALID —
--
--   SELECT indisvalid FROM pg_index WHERE indexrelid = '"Message_body_search_idx"'::regclass;
--
-- — a CONCURRENTLY build that fails leaves an INVALID index, which IF NOT EXISTS would then skip for good:
-- `DROP INDEX CONCURRENTLY "Message_body_search_idx";` and build again. Only then run `migrate deploy`; it finds
-- the extension and the index present and does nothing.
--
-- Measured on 3.6M generated messages (922 MB of table): a plain build took 31 s and the index is 240 MB, about
-- a quarter of the table; each stored message costs about 0.04 ms more to insert. A CONCURRENTLY build takes
-- longer (it scans the table twice). Check free disk first — the media volume shares it.
--
-- Prisma's schema cannot express an operator-class trigram index, so it is declared here only (the same as
-- "Message_personal_chat_idx").

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_body_search_idx" ON "Message" USING gin ("body" gin_trgm_ops);
