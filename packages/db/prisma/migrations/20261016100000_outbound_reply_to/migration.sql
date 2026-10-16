-- WhatsApp Chat v2: a manual reply can name the stored message it quotes (CHAT_UI_V2.md §4).
--
-- Additive only: one NULLABLE column on "OutboundMessage", its index, its foreign key and its Phase 7
-- same-project trigger. No existing column, index, constraint or row is changed. Adding a nullable
-- column with no default is a catalog-only change; the foreign key validates a column that is NULL on
-- every existing row. The previous application never reads or writes the column, so old and new code
-- can run against this schema side by side.
--
-- Rollback (before any row sets it): drop the trigger, the constraint, the index and the column, and
-- delete this migration's _prisma_migrations row. After rows set it, roll FORWARD.

-- AlterTable
ALTER TABLE "OutboundMessage" ADD COLUMN "replyToMessageId" TEXT;

-- CreateIndex
CREATE INDEX "OutboundMessage_replyToMessageId_idx" ON "OutboundMessage"("replyToMessageId");

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 7 integrity (MULTI_PROJECT_PLAN.md §10.7): a reply may only quote a message of its own project.
CREATE CONSTRAINT TRIGGER "OutboundMessage_replyToMessageId_same_project" AFTER INSERT OR UPDATE OF "replyToMessageId", "projectId" ON "OutboundMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Message', 'replyToMessageId');
