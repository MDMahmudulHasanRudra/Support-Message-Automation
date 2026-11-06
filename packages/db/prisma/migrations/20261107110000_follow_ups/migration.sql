-- Follow-ups (FOLLOW_UPS.md, feature FOLLOW_UPS, off by default): call-backs, technician visits and
-- promised replies, with an append-only history. Additive only: one enum, two new tables. No existing
-- row is touched. The retired Teams tables that `prisma migrate diff` proposes to drop, and the hand-built
-- "Message_body_search_idx", are deliberately left alone (CLAUDE.md).

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('OPEN', 'DONE', 'DISCARDED');

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "title" TEXT NOT NULL,
    "note" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "priority" "ConversationPriority" NOT NULL DEFAULT 'NONE',
    "status" "FollowUpStatus" NOT NULL DEFAULT 'OPEN',
    "assignedUserId" TEXT,
    "assignedTeamId" TEXT,
    "accountId" TEXT,
    "chatId" TEXT,
    "channelConversationId" TEXT,
    "clientId" TEXT,
    "createdById" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id"),
    -- A WhatsApp chat is the (account, chat id) pair: both or neither.
    CONSTRAINT "FollowUp_whatsapp_pair" CHECK (("accountId" IS NULL) = ("chatId" IS NULL)),
    -- At most one conversation: a WhatsApp chat OR a channel conversation (or none).
    CONSTRAINT "FollowUp_one_conversation" CHECK ("accountId" IS NULL OR "channelConversationId" IS NULL),
    -- Closed exactly when it carries a completion time.
    CONSTRAINT "FollowUp_completion" CHECK (("status" = 'OPEN') = ("completedAt" IS NULL)),
    CONSTRAINT "FollowUp_title_length" CHECK (char_length("title") BETWEEN 1 AND 200),
    CONSTRAINT "FollowUp_note_length" CHECK ("note" IS NULL OR char_length("note") <= 2000)
);

-- CreateTable
CREATE TABLE "FollowUpEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "followUpId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowUpEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FollowUpEvent_kind_known" CHECK ("kind" IN ('CREATED', 'EDITED', 'REASSIGNED', 'RESCHEDULED', 'DONE', 'DISCARDED', 'REOPENED'))
);

-- CreateIndex
CREATE INDEX "FollowUp_projectId_status_dueAt_idx" ON "FollowUp"("projectId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "FollowUp_projectId_assignedUserId_status_dueAt_idx" ON "FollowUp"("projectId", "assignedUserId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "FollowUp_projectId_assignedTeamId_status_dueAt_idx" ON "FollowUp"("projectId", "assignedTeamId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "FollowUp_projectId_accountId_chatId_idx" ON "FollowUp"("projectId", "accountId", "chatId");

-- CreateIndex
CREATE INDEX "FollowUp_channelConversationId_idx" ON "FollowUp"("channelConversationId");

-- CreateIndex
CREATE INDEX "FollowUp_clientId_idx" ON "FollowUp"("clientId");

-- CreateIndex
CREATE INDEX "FollowUpEvent_followUpId_createdAt_idx" ON "FollowUpEvent"("followUpId", "createdAt");

-- CreateIndex
CREATE INDEX "FollowUpEvent_projectId_createdAt_idx" ON "FollowUpEvent"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_assignedTeamId_fkey" FOREIGN KEY ("assignedTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "ChannelConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpEvent" ADD CONSTRAINT "FollowUpEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpEvent" ADD CONSTRAINT "FollowUpEvent_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database integrity (MULTI_PROJECT_PLAN.md §10.7): every parent in the follow-up's own project, and a
-- fixed project.
CREATE CONSTRAINT TRIGGER "FollowUp_assignedTeamId_same_project" AFTER INSERT OR UPDATE OF "assignedTeamId", "projectId" ON "FollowUp" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Team', 'assignedTeamId');
CREATE CONSTRAINT TRIGGER "FollowUp_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "FollowUp" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "FollowUp_channelConversationId_same_project" AFTER INSERT OR UPDATE OF "channelConversationId", "projectId" ON "FollowUp" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'channelConversationId');
CREATE CONSTRAINT TRIGGER "FollowUp_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "FollowUp" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "FollowUpEvent_followUpId_same_project" AFTER INSERT OR UPDATE OF "followUpId", "projectId" ON "FollowUpEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('FollowUp', 'followUpId');
CREATE TRIGGER "FollowUp_projectId_immutable" BEFORE UPDATE OF "projectId" ON "FollowUp" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "FollowUpEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "FollowUpEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- The history is append-only. Deletion stays possible (a follow-up's history goes with it, and a removed
-- customer's data is emptied table by table); rewriting is not.
CREATE OR REPLACE FUNCTION follow_up_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Follow-up history rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FollowUpEvent_append_only" BEFORE UPDATE ON "FollowUpEvent" FOR EACH ROW EXECUTE FUNCTION follow_up_event_append_only();
