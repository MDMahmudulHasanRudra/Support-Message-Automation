-- CreateEnum
CREATE TYPE "SupportSessionStatus" AS ENUM ('OPEN', 'COMPLETED');

-- AlterTable
ALTER TABLE "SupportKeyword" ADD COLUMN     "marksCompletion" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "status" "SupportSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openGroupId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "startedByTeamMemberId" TEXT,
    "firstActivityId" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByTeamMemberId" TEXT,
    "completionActivityId" TEXT,
    "completedByUserId" TEXT,
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportSession_openGroupId_key" ON "SupportSession"("openGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportSession_firstActivityId_key" ON "SupportSession"("firstActivityId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportSession_completionActivityId_key" ON "SupportSession"("completionActivityId");

-- CreateIndex
CREATE INDEX "SupportSession_accountId_groupId_status_idx" ON "SupportSession"("accountId", "groupId", "status");

-- CreateIndex
CREATE INDEX "SupportSession_status_startedAt_idx" ON "SupportSession"("status", "startedAt");

-- CreateIndex
CREATE INDEX "SupportSession_completedByTeamMemberId_completedAt_idx" ON "SupportSession"("completedByTeamMemberId", "completedAt");

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_startedByTeamMemberId_fkey" FOREIGN KEY ("startedByTeamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_firstActivityId_fkey" FOREIGN KEY ("firstActivityId") REFERENCES "SupportActivity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_completedByTeamMemberId_fkey" FOREIGN KEY ("completedByTeamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_completionActivityId_fkey" FOREIGN KEY ("completionActivityId") REFERENCES "SupportActivity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
