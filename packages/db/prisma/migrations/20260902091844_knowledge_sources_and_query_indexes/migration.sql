-- DEPLOY NOTE — read before running this against a live database.
--
-- The four CREATE INDEX statements at the end of this file target "Message" and "OutboundMessage",
-- the two largest tables in this system. A plain CREATE INDEX takes a lock that blocks WRITES to the
-- table for as long as the build takes, and Prisma runs each migration inside a transaction, so
-- CREATE INDEX CONCURRENTLY (which cannot run in a transaction) is not available here.
--
-- On a small or idle database this is a non-event. On a busy one with millions of Message rows it
-- will stall the worker's inserts for the duration. If that matters, either run this during a quiet
-- window with the worker stopped, or create those four indexes by hand with CONCURRENTLY first and
-- then mark this migration applied with `prisma migrate resolve --applied`.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "KnowledgeImportSourceType" ADD VALUE 'URL';
ALTER TYPE "KnowledgeImportSourceType" ADD VALUE 'PDF';
ALTER TYPE "KnowledgeImportSourceType" ADD VALUE 'DOCX';
ALTER TYPE "KnowledgeImportSourceType" ADD VALUE 'SPREADSHEET';

-- DropIndex
DROP INDEX "Message_conversationSessionId_idx";

-- AlterTable
ALTER TABLE "AiKnowledgeItem" ADD COLUMN     "sourceUrl" TEXT;

-- AlterTable
ALTER TABLE "KnowledgeImport" ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "sourceUrl" TEXT;

-- CreateIndex
CREATE INDEX "AiKnowledgeItem_module_idx" ON "AiKnowledgeItem"("module");

-- CreateIndex
CREATE INDEX "Message_conversationSessionId_timestampWa_idx" ON "Message"("conversationSessionId", "timestampWa");

-- CreateIndex
CREATE INDEX "Message_timestampWa_idx" ON "Message"("timestampWa");

-- CreateIndex
CREATE INDEX "Message_direction_createdAt_idx" ON "Message"("direction", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundMessage_accountId_status_sentAt_idx" ON "OutboundMessage"("accountId", "status", "sentAt");
