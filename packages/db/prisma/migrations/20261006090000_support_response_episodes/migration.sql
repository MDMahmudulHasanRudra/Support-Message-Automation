-- Support response tracking (SUPPORT_RESPONSE.md): Messages -> Unanswered Groups / Response Time.
--
-- Additive only:
--   SupportResponseEpisode                      one row per support-response episode in a group,
--                                               referencing its Message rows, never copying them;
--   SupportActivitySettings.responseTrackingTeamIds   which Teams are the Support Team (empty =
--                                               nothing tracked until an admin chooses).
-- No existing row is rewritten and nothing is backfilled: tracking starts with the next message.
-- The retired Teams tables that `prisma migrate diff` proposes dropping are deliberately left alone.

-- CreateEnum
CREATE TYPE "SupportResponseEpisodeStatus" AS ENUM ('UNANSWERED', 'ANSWERED', 'CLEARED');

-- AlterTable
ALTER TABLE "SupportActivitySettings" ADD COLUMN     "responseTrackingTeamIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "SupportResponseEpisode" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "status" "SupportResponseEpisodeStatus" NOT NULL DEFAULT 'UNANSWERED',
    "firstIncomingMessageId" TEXT,
    "firstIncomingAt" TIMESTAMP(3) NOT NULL,
    "latestIncomingMessageId" TEXT,
    "latestIncomingAt" TIMESTAMP(3) NOT NULL,
    "incomingMessageCount" INTEGER NOT NULL DEFAULT 1,
    "supportReplyMessageId" TEXT,
    "supportRepliedAt" TIMESTAMP(3),
    "supportMemberId" TEXT,
    "supportTeamId" TEXT,
    "responseSeconds" INTEGER,
    "clearedAt" TIMESTAMP(3),
    "clearedByUserId" TEXT,
    "clearReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportResponseEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportResponseEpisode_projectId_status_firstIncomingAt_idx" ON "SupportResponseEpisode"("projectId", "status", "firstIncomingAt");

-- CreateIndex
CREATE INDEX "SupportResponseEpisode_projectId_status_supportRepliedAt_idx" ON "SupportResponseEpisode"("projectId", "status", "supportRepliedAt");

-- CreateIndex
CREATE INDEX "SupportResponseEpisode_groupId_status_idx" ON "SupportResponseEpisode"("groupId", "status");

-- CreateIndex
CREATE INDEX "SupportResponseEpisode_supportMemberId_supportRepliedAt_idx" ON "SupportResponseEpisode"("supportMemberId", "supportRepliedAt");

-- CreateIndex
CREATE INDEX "SupportResponseEpisode_accountId_idx" ON "SupportResponseEpisode"("accountId");

-- AddForeignKey
ALTER TABLE "SupportResponseEpisode" ADD CONSTRAINT "SupportResponseEpisode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportResponseEpisode" ADD CONSTRAINT "SupportResponseEpisode_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportResponseEpisode" ADD CONSTRAINT "SupportResponseEpisode_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportResponseEpisode" ADD CONSTRAINT "SupportResponseEpisode_firstIncomingMessageId_fkey" FOREIGN KEY ("firstIncomingMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportResponseEpisode" ADD CONSTRAINT "SupportResponseEpisode_latestIncomingMessageId_fkey" FOREIGN KEY ("latestIncomingMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportResponseEpisode" ADD CONSTRAINT "SupportResponseEpisode_supportReplyMessageId_fkey" FOREIGN KEY ("supportReplyMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportResponseEpisode" ADD CONSTRAINT "SupportResponseEpisode_supportMemberId_fkey" FOREIGN KEY ("supportMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportResponseEpisode" ADD CONSTRAINT "SupportResponseEpisode_supportTeamId_fkey" FOREIGN KEY ("supportTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportResponseEpisode" ADD CONSTRAINT "SupportResponseEpisode_clearedByUserId_fkey" FOREIGN KEY ("clearedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one open episode per group row, whatever the timing of two messages arriving together.
CREATE UNIQUE INDEX "SupportResponseEpisode_groupId_open_key" ON "SupportResponseEpisode"("groupId") WHERE "status" = 'UNANSWERED';

-- Phase 7 integrity: every row an episode references is in its own project, and no row changes project.
CREATE CONSTRAINT TRIGGER "SupportResponseEpisode_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "SupportResponseEpisode" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "SupportResponseEpisode_groupId_same_project" AFTER INSERT OR UPDATE OF "groupId", "projectId" ON "SupportResponseEpisode" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppGroup', 'groupId');
CREATE CONSTRAINT TRIGGER "SupportResponseEpisode_firstIncomingMessageId_same_project" AFTER INSERT OR UPDATE OF "firstIncomingMessageId", "projectId" ON "SupportResponseEpisode" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Message', 'firstIncomingMessageId');
CREATE CONSTRAINT TRIGGER "SupportResponseEpisode_latestIncomingMessageId_same_project" AFTER INSERT OR UPDATE OF "latestIncomingMessageId", "projectId" ON "SupportResponseEpisode" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Message', 'latestIncomingMessageId');
CREATE CONSTRAINT TRIGGER "SupportResponseEpisode_supportReplyMessageId_same_project" AFTER INSERT OR UPDATE OF "supportReplyMessageId", "projectId" ON "SupportResponseEpisode" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Message', 'supportReplyMessageId');
CREATE CONSTRAINT TRIGGER "SupportResponseEpisode_supportMemberId_same_project" AFTER INSERT OR UPDATE OF "supportMemberId", "projectId" ON "SupportResponseEpisode" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'supportMemberId');
CREATE CONSTRAINT TRIGGER "SupportResponseEpisode_supportTeamId_same_project" AFTER INSERT OR UPDATE OF "supportTeamId", "projectId" ON "SupportResponseEpisode" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Team', 'supportTeamId');
CREATE TRIGGER "SupportResponseEpisode_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SupportResponseEpisode" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
