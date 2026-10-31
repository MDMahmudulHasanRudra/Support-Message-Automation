-- Inbox workspace (INBOX_WORKSPACE.md): internal notes, priority/tags, team assignment for channel
-- conversations, and AI Copilot drafts. Additive only: three new tables, one nullable column, three
-- enums. Nothing existing changes meaning, and nothing reads these until a project switches on
-- INBOX_COLLABORATION or AI_COPILOT (both off by default).
-- Rollback: DROP TABLE "AiDraft", "ConversationNote", "ConversationLabel";
--           ALTER TABLE "ChannelConversation" DROP COLUMN "assignedTeamId";
--           DROP TYPE "AiDraftStatus", "AiDraftMode", "ConversationPriority";

-- CreateEnum
CREATE TYPE "ConversationPriority" AS ENUM ('NONE', 'LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "AiDraftMode" AS ENUM ('ASSIST', 'DRAFT', 'REWRITE');

-- CreateEnum
CREATE TYPE "AiDraftStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');

-- AlterTable
ALTER TABLE "ChannelConversation" ADD COLUMN     "assignedTeamId" TEXT;

-- CreateTable
CREATE TABLE "ConversationLabel" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT,
    "chatId" TEXT,
    "channelConversationId" TEXT,
    "priority" "ConversationPriority" NOT NULL DEFAULT 'NONE',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationNote" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT,
    "chatId" TEXT,
    "channelConversationId" TEXT,
    "body" TEXT NOT NULL,
    "mentionedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "ConversationNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDraft" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT,
    "chatId" TEXT,
    "channelConversationId" TEXT,
    "mode" "AiDraftMode" NOT NULL,
    "instruction" TEXT,
    "baseText" TEXT,
    "status" "AiDraftStatus" NOT NULL DEFAULT 'PENDING',
    "responseText" TEXT,
    "summary" TEXT,
    "intent" TEXT,
    "scope" TEXT,
    "confidence" INTEGER,
    "grounded" BOOLEAN NOT NULL DEFAULT false,
    "knowledgeTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warning" TEXT,
    "reason" TEXT,
    "error" TEXT,
    "providerId" TEXT,
    "modelId" TEXT,
    "tokensUsed" INTEGER,
    "requestedById" TEXT,
    "usedAt" TIMESTAMP(3),
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationLabel_channelConversationId_key" ON "ConversationLabel"("channelConversationId");

-- CreateIndex
CREATE INDEX "ConversationLabel_projectId_priority_idx" ON "ConversationLabel"("projectId", "priority");

-- CreateIndex
CREATE INDEX "ConversationLabel_projectId_accountId_chatId_idx" ON "ConversationLabel"("projectId", "accountId", "chatId");

-- CreateIndex
CREATE INDEX "ConversationNote_projectId_accountId_chatId_createdAt_idx" ON "ConversationNote"("projectId", "accountId", "chatId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationNote_channelConversationId_createdAt_idx" ON "ConversationNote"("channelConversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiDraft_status_createdAt_idx" ON "AiDraft"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AiDraft_projectId_createdAt_idx" ON "AiDraft"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AiDraft_projectId_accountId_chatId_createdAt_idx" ON "AiDraft"("projectId", "accountId", "chatId", "createdAt");

-- CreateIndex
CREATE INDEX "AiDraft_channelConversationId_createdAt_idx" ON "AiDraft"("channelConversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChannelConversation" ADD CONSTRAINT "ChannelConversation_assignedTeamId_fkey" FOREIGN KEY ("assignedTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "ChannelConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "ChannelConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "ChannelConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Every row names exactly one conversation: a WhatsApp chat (account + chat id) or a channel conversation.
ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_one_conversation" CHECK (
  ("channelConversationId" IS NOT NULL AND "accountId" IS NULL AND "chatId" IS NULL)
  OR ("channelConversationId" IS NULL AND "accountId" IS NOT NULL AND "chatId" IS NOT NULL)
);
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_one_conversation" CHECK (
  ("channelConversationId" IS NOT NULL AND "accountId" IS NULL AND "chatId" IS NULL)
  OR ("channelConversationId" IS NULL AND "accountId" IS NOT NULL AND "chatId" IS NOT NULL)
);
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_one_conversation" CHECK (
  ("channelConversationId" IS NOT NULL AND "accountId" IS NULL AND "chatId" IS NULL)
  OR ("channelConversationId" IS NULL AND "accountId" IS NOT NULL AND "chatId" IS NOT NULL)
);
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_body_bounded" CHECK (length("body") BETWEEN 1 AND 4000);
ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_tags_bounded" CHECK (cardinality("tags") <= 12);

-- One label row per WhatsApp conversation (the channel side is the plain unique above).
CREATE UNIQUE INDEX "ConversationLabel_whatsapp_key" ON "ConversationLabel"("projectId", "accountId", "chatId") WHERE "channelConversationId" IS NULL;

-- Project integrity (MULTI_PROJECT_PLAN.md §10.7).
CREATE TRIGGER "ConversationLabel_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ConversationLabel" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ConversationNote_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ConversationNote" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "AiDraft_projectId_immutable" BEFORE UPDATE OF "projectId" ON "AiDraft" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "ConversationLabel_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "ConversationLabel" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "ConversationLabel_channelConversationId_same_project" AFTER INSERT OR UPDATE OF "channelConversationId", "projectId" ON "ConversationLabel" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'channelConversationId');
CREATE CONSTRAINT TRIGGER "ConversationNote_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "ConversationNote" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "ConversationNote_channelConversationId_same_project" AFTER INSERT OR UPDATE OF "channelConversationId", "projectId" ON "ConversationNote" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'channelConversationId');
CREATE CONSTRAINT TRIGGER "AiDraft_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "AiDraft" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "AiDraft_channelConversationId_same_project" AFTER INSERT OR UPDATE OF "channelConversationId", "projectId" ON "AiDraft" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'channelConversationId');
CREATE CONSTRAINT TRIGGER "ChannelConversation_assignedTeamId_same_project" AFTER INSERT OR UPDATE OF "assignedTeamId", "projectId" ON "ChannelConversation" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Team', 'assignedTeamId');
