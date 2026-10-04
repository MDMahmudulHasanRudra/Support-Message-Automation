-- WhatsApp Groups Admin Maker (GROUP_ADMIN_MAKER.md): a persistent background job that makes ONE
-- existing member an admin in every group where the selected account is itself an admin.
--
-- Additive only: two enums, two tables, their indexes and foreign keys. Nothing existing is altered,
-- and no existing row is read or written. (The retired Microsoft Teams tables that `prisma migrate
-- diff` also proposes dropping are deliberately left alone — see CLAUDE.md, "Microsoft Teams
-- Integration — REMOVED".)
--
-- Both tables are project-owned, so they get the Phase 7 guards (MULTI_PROJECT_PLAN.md §10.7): a
-- same-project trigger on each reference between project tables, and "projectId" made immutable.
-- projectIntegrity.integration.test.ts compares the catalog with these and fails if one is missing.

-- CreateEnum
CREATE TYPE "GroupAdminPromotionJobStatus" AS ENUM ('CHECKING', 'RUNNING', 'PAUSED_DISCONNECTED', 'STOPPED_KILL_SWITCH', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GroupAdminPromotionItemStatus" AS ENUM ('PENDING', 'PROMOTED', 'ALREADY_ADMIN', 'NOT_MEMBER', 'NOT_ACCOUNT_ADMIN', 'CANNOT_VERIFY', 'GROUP_UNAVAILABLE', 'FAILED');

-- CreateTable
CREATE TABLE "GroupAdminPromotionJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT NOT NULL,
    "createdById" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "status" "GroupAdminPromotionJobStatus" NOT NULL DEFAULT 'CHECKING',
    "totalGroups" INTEGER NOT NULL DEFAULT 0,
    "adminGroups" INTEGER,
    "statusReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupAdminPromotionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupAdminPromotionItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "jobId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupNameSnapshot" TEXT NOT NULL,
    "status" "GroupAdminPromotionItemStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "failureCode" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupAdminPromotionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupAdminPromotionJob_accountId_phoneNumber_status_idx" ON "GroupAdminPromotionJob"("accountId", "phoneNumber", "status");

-- CreateIndex
CREATE INDEX "GroupAdminPromotionJob_status_idx" ON "GroupAdminPromotionJob"("status");

-- CreateIndex
CREATE INDEX "GroupAdminPromotionItem_jobId_status_idx" ON "GroupAdminPromotionItem"("jobId", "status");

-- CreateIndex
CREATE INDEX "GroupAdminPromotionItem_status_scheduledAt_idx" ON "GroupAdminPromotionItem"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "GroupAdminPromotionItem_jobId_groupId_key" ON "GroupAdminPromotionItem"("jobId", "groupId");

-- AddForeignKey
ALTER TABLE "GroupAdminPromotionJob" ADD CONSTRAINT "GroupAdminPromotionJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupAdminPromotionJob" ADD CONSTRAINT "GroupAdminPromotionJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupAdminPromotionJob" ADD CONSTRAINT "GroupAdminPromotionJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupAdminPromotionItem" ADD CONSTRAINT "GroupAdminPromotionItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupAdminPromotionItem" ADD CONSTRAINT "GroupAdminPromotionItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GroupAdminPromotionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupAdminPromotionItem" ADD CONSTRAINT "GroupAdminPromotionItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 7 guards: a row may only point at parents in its own project, and never changes project.
CREATE CONSTRAINT TRIGGER "GroupAdminPromotionJob_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "GroupAdminPromotionJob" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "GroupAdminPromotionItem_jobId_same_project" AFTER INSERT OR UPDATE OF "jobId", "projectId" ON "GroupAdminPromotionItem" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('GroupAdminPromotionJob', 'jobId');
CREATE CONSTRAINT TRIGGER "GroupAdminPromotionItem_groupId_same_project" AFTER INSERT OR UPDATE OF "groupId", "projectId" ON "GroupAdminPromotionItem" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppGroup', 'groupId');
CREATE TRIGGER "GroupAdminPromotionJob_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GroupAdminPromotionJob" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "GroupAdminPromotionItem_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GroupAdminPromotionItem" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
