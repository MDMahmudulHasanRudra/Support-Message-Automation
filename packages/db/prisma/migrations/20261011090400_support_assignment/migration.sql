-- Support Assignment (SUPPORT_ASSIGNMENT.md). Additive: three new, empty tables, two enums and one
-- nullable column. Nothing existing is altered or backfilled. The module is off until an admin
-- enables it on Settings → Support Assignment; an absent settings row means "off, with the defaults".
--
-- SupportAssignment          one case per customer wait, referencing the existing
--                            SupportResponseEpisode so "unanswered" keeps its one definition. At most
--                            one CURRENT case per WhatsApp group (partial unique index below), so two
--                            of our numbers in one group, or two racing messages, never open two.
-- SupportAssignmentEvent     the case's history. (assignmentId, dedupKey) UNIQUE makes every
--                            notification at most once across retries, restarts and racing workers.
-- SupportAssignmentSettings  the per-project singleton.
-- InternalTeamMember.userId  links a roster member to their dashboard login, for "My Assignments"
--                            only. Nullable, unique per project, SET NULL if the login is removed.
--
-- The new tables are small and new, so plain CREATE INDEX is fine (the CONCURRENTLY escape hatch is
-- only for Message/OutboundMessage). The NotificationEvent value is added by the previous migration.

-- CreateEnum
CREATE TYPE "SupportAssignmentStatus" AS ENUM ('IGNORED', 'UNASSIGNED', 'ASSIGNED', 'OVERDUE', 'COMPLETED', 'ANSWERED_BY_OTHER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupportAssignmentEventType" AS ENUM ('OPENED', 'IGNORED', 'QUALIFIED', 'ASSIGNED', 'REASSIGNED', 'NOTIFIED', 'NOTIFY_SKIPPED', 'OVERDUE', 'ESCALATED', 'COMPLETED', 'ANSWERED_BY_OTHER', 'CANCELLED');


-- AlterTable
ALTER TABLE "InternalTeamMember" ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "SupportAssignment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "episodeId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "whatsappGroupId" TEXT NOT NULL,
    "status" "SupportAssignmentStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "firstMessageId" TEXT,
    "firstMessageAt" TIMESTAMP(3),
    "ignoredMessageCount" INTEGER NOT NULL DEFAULT 0,
    "assignedMemberId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "assignedByUserId" TEXT,
    "assignmentRound" INTEGER NOT NULL DEFAULT 0,
    "slaMinutes" INTEGER,
    "dueAt" TIMESTAMP(3),
    "overdueAt" TIMESTAMP(3),
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "nextEscalationAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completionMessageId" TEXT,
    "responderMemberId" TEXT,
    "responseSeconds" INTEGER,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAssignmentEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "assignmentId" TEXT NOT NULL,
    "type" "SupportAssignmentEventType" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "memberId" TEXT,
    "notificationId" TEXT,
    "recipient" TEXT,
    "detail" TEXT,
    "dedupKey" TEXT,

    CONSTRAINT "SupportAssignmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAssignmentSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "ignoredKeywords" TEXT[] DEFAULT ARRAY['thank you', 'thanks', 'thanks brother', 'ok', 'okay', 'done', 'received', 'alright', 'ধন্যবাদ']::TEXT[],
    "ignoredSenders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assignableTeamIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "slaMinutes" INTEGER NOT NULL DEFAULT 15,
    "escalationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "escalationAfterMinutes" INTEGER NOT NULL DEFAULT 15,
    "managerGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "adminMemberIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notifyEmployeeOnAssign" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmployeeOnReassign" BOOLEAN NOT NULL DEFAULT true,
    "notifyManagerOnOverdue" BOOLEAN NOT NULL DEFAULT true,
    "notifyAdminOnOverdue" BOOLEAN NOT NULL DEFAULT false,
    "notifyAdminOnEscalation" BOOLEAN NOT NULL DEFAULT true,
    "notifyAdminOnCompletion" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportAssignmentSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportAssignment_projectId_status_createdAt_idx" ON "SupportAssignment"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SupportAssignment_projectId_status_dueAt_idx" ON "SupportAssignment"("projectId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "SupportAssignment_projectId_status_nextEscalationAt_idx" ON "SupportAssignment"("projectId", "status", "nextEscalationAt");

-- CreateIndex
CREATE INDEX "SupportAssignment_groupId_status_idx" ON "SupportAssignment"("groupId", "status");

-- CreateIndex
CREATE INDEX "SupportAssignment_assignedMemberId_status_idx" ON "SupportAssignment"("assignedMemberId", "status");

-- CreateIndex
CREATE INDEX "SupportAssignment_episodeId_idx" ON "SupportAssignment"("episodeId");

-- CreateIndex
CREATE INDEX "SupportAssignment_whatsappGroupId_closedAt_idx" ON "SupportAssignment"("whatsappGroupId", "closedAt");

-- CreateIndex
CREATE INDEX "SupportAssignment_accountId_idx" ON "SupportAssignment"("accountId");

-- CreateIndex
CREATE INDEX "SupportAssignmentEvent_assignmentId_at_idx" ON "SupportAssignmentEvent"("assignmentId", "at");

-- CreateIndex
CREATE INDEX "SupportAssignmentEvent_projectId_type_at_idx" ON "SupportAssignmentEvent"("projectId", "type", "at");

-- CreateIndex
CREATE UNIQUE INDEX "SupportAssignmentEvent_assignmentId_dedupKey_key" ON "SupportAssignmentEvent"("assignmentId", "dedupKey");

-- CreateIndex
CREATE UNIQUE INDEX "SupportAssignmentSettings_projectId_key" ON "SupportAssignmentSettings"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "InternalTeamMember_projectId_userId_key" ON "InternalTeamMember"("projectId", "userId");

-- AddForeignKey
ALTER TABLE "InternalTeamMember" ADD CONSTRAINT "InternalTeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignment" ADD CONSTRAINT "SupportAssignment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignment" ADD CONSTRAINT "SupportAssignment_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "SupportResponseEpisode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignment" ADD CONSTRAINT "SupportAssignment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignment" ADD CONSTRAINT "SupportAssignment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignment" ADD CONSTRAINT "SupportAssignment_firstMessageId_fkey" FOREIGN KEY ("firstMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignment" ADD CONSTRAINT "SupportAssignment_assignedMemberId_fkey" FOREIGN KEY ("assignedMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignment" ADD CONSTRAINT "SupportAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignment" ADD CONSTRAINT "SupportAssignment_completionMessageId_fkey" FOREIGN KEY ("completionMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignment" ADD CONSTRAINT "SupportAssignment_responderMemberId_fkey" FOREIGN KEY ("responderMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignmentEvent" ADD CONSTRAINT "SupportAssignmentEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignmentEvent" ADD CONSTRAINT "SupportAssignmentEvent_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "SupportAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignmentEvent" ADD CONSTRAINT "SupportAssignmentEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignmentEvent" ADD CONSTRAINT "SupportAssignmentEvent_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignmentEvent" ADD CONSTRAINT "SupportAssignmentEvent_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAssignmentSettings" ADD CONSTRAINT "SupportAssignmentSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one CURRENT case per WhatsApp group per project. Keyed on the WhatsApp group rather than
-- the account's group row, so two of our numbers in one group cannot open two cases for one wait.
CREATE UNIQUE INDEX "SupportAssignment_current_per_group_key" ON "SupportAssignment"("projectId", "whatsappGroupId") WHERE "closedAt" IS NULL;

-- Phase 7 integrity: a case, its history and its references always belong to one project.
CREATE CONSTRAINT TRIGGER "SupportAssignment_episodeId_same_project" AFTER INSERT OR UPDATE OF "episodeId", "projectId" ON "SupportAssignment" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SupportResponseEpisode', 'episodeId');
CREATE CONSTRAINT TRIGGER "SupportAssignment_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "SupportAssignment" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "SupportAssignment_groupId_same_project" AFTER INSERT OR UPDATE OF "groupId", "projectId" ON "SupportAssignment" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppGroup', 'groupId');
CREATE CONSTRAINT TRIGGER "SupportAssignment_firstMessageId_same_project" AFTER INSERT OR UPDATE OF "firstMessageId", "projectId" ON "SupportAssignment" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Message', 'firstMessageId');
CREATE CONSTRAINT TRIGGER "SupportAssignment_assignedMemberId_same_project" AFTER INSERT OR UPDATE OF "assignedMemberId", "projectId" ON "SupportAssignment" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'assignedMemberId');
CREATE CONSTRAINT TRIGGER "SupportAssignment_completionMessageId_same_project" AFTER INSERT OR UPDATE OF "completionMessageId", "projectId" ON "SupportAssignment" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Message', 'completionMessageId');
CREATE CONSTRAINT TRIGGER "SupportAssignment_responderMemberId_same_project" AFTER INSERT OR UPDATE OF "responderMemberId", "projectId" ON "SupportAssignment" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'responderMemberId');
CREATE CONSTRAINT TRIGGER "SupportAssignmentEvent_assignmentId_same_project" AFTER INSERT OR UPDATE OF "assignmentId", "projectId" ON "SupportAssignmentEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SupportAssignment', 'assignmentId');
CREATE CONSTRAINT TRIGGER "SupportAssignmentEvent_memberId_same_project" AFTER INSERT OR UPDATE OF "memberId", "projectId" ON "SupportAssignmentEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'memberId');
CREATE CONSTRAINT TRIGGER "SupportAssignmentEvent_notificationId_same_project" AFTER INSERT OR UPDATE OF "notificationId", "projectId" ON "SupportAssignmentEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Notification', 'notificationId');
CREATE TRIGGER "SupportAssignment_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SupportAssignment" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SupportAssignmentEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SupportAssignmentEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SupportAssignmentSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SupportAssignmentSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
