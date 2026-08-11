-- CreateEnum
CREATE TYPE "GroupBroadcastJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'STOPPED_KILL_SWITCH');

-- CreateEnum
CREATE TYPE "GroupBroadcastSource" AS ENUM ('MANUAL', 'EXCEL', 'MIXED');

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE 'GROUP_BROADCAST';

-- AlterEnum
ALTER TYPE "OutboundMessageStatus" ADD VALUE 'SKIPPED';

-- AlterTable
ALTER TABLE "OutboundMessage" ADD COLUMN     "broadcastJobId" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "groupNameSnapshot" TEXT,
ADD COLUMN     "providerMessageId" TEXT;

-- CreateTable
CREATE TABLE "GroupBroadcastJob" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdById" TEXT,
    "source" "GroupBroadcastSource" NOT NULL,
    "defaultMessage" TEXT NOT NULL,
    "status" "GroupBroadcastJobStatus" NOT NULL DEFAULT 'QUEUED',
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

    CONSTRAINT "GroupBroadcastJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupBroadcastSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "delayMinMs" INTEGER NOT NULL DEFAULT 5000,
    "delayMaxMs" INTEGER NOT NULL DEFAULT 15000,
    "maxPerMinute" INTEGER NOT NULL DEFAULT 6,
    "maxPerJob" INTEGER NOT NULL DEFAULT 200,
    "retryMaxAttempts" INTEGER NOT NULL DEFAULT 2,
    "duplicateGroupCooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupBroadcastSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupBroadcastJob_accountId_createdAt_idx" ON "GroupBroadcastJob"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "GroupBroadcastJob_status_idx" ON "GroupBroadcastJob"("status");

-- CreateIndex
CREATE INDEX "OutboundMessage_broadcastJobId_status_idx" ON "OutboundMessage"("broadcastJobId", "status");

-- CreateIndex
CREATE INDEX "OutboundMessage_groupId_status_idx" ON "OutboundMessage"("groupId", "status");

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_broadcastJobId_fkey" FOREIGN KEY ("broadcastJobId") REFERENCES "GroupBroadcastJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBroadcastJob" ADD CONSTRAINT "GroupBroadcastJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBroadcastJob" ADD CONSTRAINT "GroupBroadcastJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
