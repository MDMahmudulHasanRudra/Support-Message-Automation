-- CreateEnum
CREATE TYPE "GroupParticipantAddJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'STOPPED_KILL_SWITCH');

-- CreateEnum
CREATE TYPE "GroupParticipantAddItemStatus" AS ENUM ('PENDING', 'PROCESSING', 'ADDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "GroupParticipantAddJob" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdById" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "status" "GroupParticipantAddJobStatus" NOT NULL DEFAULT 'QUEUED',
    "totalRequested" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "preQueueSkipped" INTEGER NOT NULL DEFAULT 0,
    "preQueueSkipReasons" JSONB NOT NULL DEFAULT '[]',
    "delayMinMs" INTEGER NOT NULL,
    "delayMaxMs" INTEGER NOT NULL,
    "maxPerMinute" INTEGER NOT NULL,
    "maxPerJob" INTEGER NOT NULL,
    "retryMaxAttempts" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "GroupParticipantAddJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupParticipantAddItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupNameSnapshot" TEXT NOT NULL,
    "status" "GroupParticipantAddItemStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupParticipantAddItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupParticipantAddSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "delayMinMs" INTEGER NOT NULL DEFAULT 10000,
    "delayMaxMs" INTEGER NOT NULL DEFAULT 30000,
    "maxPerMinute" INTEGER NOT NULL DEFAULT 3,
    "maxPerJob" INTEGER NOT NULL DEFAULT 100,
    "retryMaxAttempts" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupParticipantAddSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupParticipantAddJob_accountId_createdAt_idx" ON "GroupParticipantAddJob"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "GroupParticipantAddJob_status_idx" ON "GroupParticipantAddJob"("status");

-- CreateIndex
CREATE INDEX "GroupParticipantAddItem_status_scheduledAt_idx" ON "GroupParticipantAddItem"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "GroupParticipantAddItem_jobId_groupId_key" ON "GroupParticipantAddItem"("jobId", "groupId");

-- AddForeignKey
ALTER TABLE "GroupParticipantAddJob" ADD CONSTRAINT "GroupParticipantAddJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupParticipantAddJob" ADD CONSTRAINT "GroupParticipantAddJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupParticipantAddItem" ADD CONSTRAINT "GroupParticipantAddItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GroupParticipantAddJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupParticipantAddItem" ADD CONSTRAINT "GroupParticipantAddItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
