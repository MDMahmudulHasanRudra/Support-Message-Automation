-- WhatsApp Chat: Groups / Personal filter. Additive: one new, empty table. Nothing existing is
-- altered or backfilled, and no conversation is created, moved or deleted.
--
-- A personal (1:1) chat has no row of its own — it is its Message rows (groupId NULL, chat id ending
-- @c.us or @lid), and the inbox derives it from them. The only thing that cannot be derived is the
-- review mark behind "Seen, unanswered", which for a group lives on WhatsAppGroup.chatReviewedAt.
-- This table is that mark for personal chats: a row once somebody opened the chat, none before.
-- Display only; the worker never reads or writes it.
--
-- A small, new table, so plain CREATE INDEX is fine here. The Message index the personal list needs
-- is in the next migration, on its own, because that one touches a large table.

-- CreateTable
CREATE TABLE "PersonalChatReview" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalChatReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PersonalChatReview_projectId_accountId_chatId_key" ON "PersonalChatReview"("projectId", "accountId", "chatId");

-- AddForeignKey
ALTER TABLE "PersonalChatReview" ADD CONSTRAINT "PersonalChatReview_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalChatReview" ADD CONSTRAINT "PersonalChatReview_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 7 integrity: the account is in the same project, and no row changes project.
CREATE CONSTRAINT TRIGGER "PersonalChatReview_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "PersonalChatReview" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE TRIGGER "PersonalChatReview_projectId_immutable" BEFORE UPDATE OF "projectId" ON "PersonalChatReview" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
