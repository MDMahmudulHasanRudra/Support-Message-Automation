-- Chat v2 rich messaging (CHAT_RICH_MESSAGING.md): delivery and read receipts, deleted-for-everyone,
-- stars, polls and locations on stored messages, and typed content on the outbound queue.
--
-- Additive only. Every new "Message" column is NULLABLE with no default (a catalog-only change on a
-- large table). The new "OutboundMessage"."contentType" is NOT NULL with a constant default, which
-- Postgres 11+ also records in the catalog without rewriting the table; every existing row reads as
-- TEXT, which is exactly what it is. No index, constraint or existing column changes, and no new
-- relation between project-owned tables (so no new same-project trigger is needed — "content" names
-- rows by id and the worker re-reads each one through the project-scoped client).
--
-- The previous application never reads or writes these columns, so old and new code can run against
-- this schema side by side. Rollback (before any row uses them): drop the columns and the type, and
-- delete this migration's _prisma_migrations row. After rows use them, roll FORWARD.

-- CreateEnum
CREATE TYPE "OutboundContentType" AS ENUM ('TEXT', 'POLL', 'LOCATION', 'STICKER', 'FORWARD');

-- AlterTable
ALTER TABLE "Message"
  ADD COLUMN "ackLevel" INTEGER,
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "readAt" TIMESTAMP(3),
  ADD COLUMN "playedAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "starredAt" TIMESTAMP(3),
  ADD COLUMN "richContent" JSONB,
  ADD COLUMN "loadedFromHistoryAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OutboundMessage"
  ADD COLUMN "contentType" "OutboundContentType" NOT NULL DEFAULT 'TEXT',
  ADD COLUMN "content" JSONB;
