-- Reporting data health (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md, stage 1).
--
-- Additive only:
--   CollectionGap                                  one row per period a WhatsApp account was not
--                                                  collecting, written by the worker from now on;
--   SupportActivitySettings.reportingVerifiedFrom  per project; null = nothing verified yet.
-- Nothing is backfilled: collection health was never recorded before this table, and pretending
-- otherwise would make history look verified when it is not. The retired Teams tables that
-- `prisma migrate diff` proposes dropping are deliberately left alone.

-- CreateEnum
CREATE TYPE "CollectionGapRecovery" AS ENUM ('RECOVERED', 'PARTIAL', 'FAILED', 'NOT_ATTEMPTED');

-- AlterTable
ALTER TABLE "SupportActivitySettings" ADD COLUMN     "reportingVerifiedFrom" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CollectionGap" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "recoveryStatus" "CollectionGapRecovery",
    "recoveryAttemptedAt" TIMESTAMP(3),
    "recoveredFrom" TIMESTAMP(3),
    "recoveredCount" INTEGER NOT NULL DEFAULT 0,
    "recoveryNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionGap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectionGap_projectId_startedAt_idx" ON "CollectionGap"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "CollectionGap_accountId_endedAt_idx" ON "CollectionGap"("accountId", "endedAt");

-- AddForeignKey
ALTER TABLE "CollectionGap" ADD CONSTRAINT "CollectionGap_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionGap" ADD CONSTRAINT "CollectionGap_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one open gap per account, however many paths notice the same outage at once.
CREATE UNIQUE INDEX "CollectionGap_accountId_open_key" ON "CollectionGap"("accountId") WHERE "endedAt" IS NULL;

-- Phase 7 integrity: the account is in the gap's own project, and no row changes project.
CREATE CONSTRAINT TRIGGER "CollectionGap_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "CollectionGap" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE TRIGGER "CollectionGap_projectId_immutable" BEFORE UPDATE OF "projectId" ON "CollectionGap" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
