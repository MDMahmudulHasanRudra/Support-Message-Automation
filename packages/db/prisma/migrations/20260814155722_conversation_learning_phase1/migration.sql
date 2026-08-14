-- CreateEnum
CREATE TYPE "ConversationSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "LearningBatchJobType" AS ENUM ('CONVERSATION_SEGMENTATION', 'PATTERN_DETECTION', 'AI_ANALYSIS');

-- CreateEnum
CREATE TYPE "LearningBatchJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LearningBatchJobTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "conversationSessionId" TEXT;

-- CreateTable
CREATE TABLE "ConversationSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "groupId" TEXT,
    "status" "ConversationSessionStatus" NOT NULL DEFAULT 'OPEN',
    "firstMessageAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "participantPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "conversationLearningEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sessionGapMinutes" INTEGER NOT NULL DEFAULT 30,
    "minOccurrenceForCandidate" INTEGER NOT NULL DEFAULT 3,
    "minDistinctGroupsForCandidate" INTEGER NOT NULL DEFAULT 2,
    "minDistinctClientsForCandidate" INTEGER NOT NULL DEFAULT 2,
    "candidateExpiryDays" INTEGER NOT NULL DEFAULT 30,
    "autoApprovalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoApprovalMinConfidence" INTEGER NOT NULL DEFAULT 97,
    "weightFrequency" INTEGER NOT NULL DEFAULT 25,
    "weightDiversity" INTEGER NOT NULL DEFAULT 20,
    "weightConsistency" INTEGER NOT NULL DEFAULT 20,
    "weightResolution" INTEGER NOT NULL DEFAULT 15,
    "weightRecency" INTEGER NOT NULL DEFAULT 10,
    "weightAiConfidence" INTEGER NOT NULL DEFAULT 10,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningBatchJob" (
    "id" TEXT NOT NULL,
    "jobType" "LearningBatchJobType" NOT NULL,
    "trigger" "LearningBatchJobTrigger" NOT NULL,
    "status" "LearningBatchJobStatus" NOT NULL DEFAULT 'QUEUED',
    "triggeredById" TEXT,
    "aiProviderId" TEXT,
    "candidatesConsidered" INTEGER NOT NULL DEFAULT 0,
    "candidatesUpdated" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningBatchJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationSession_accountId_chatId_status_idx" ON "ConversationSession"("accountId", "chatId", "status");

-- CreateIndex
CREATE INDEX "ConversationSession_status_lastMessageAt_idx" ON "ConversationSession"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "LearningBatchJob_status_jobType_idx" ON "LearningBatchJob"("status", "jobType");

-- CreateIndex
CREATE INDEX "LearningBatchJob_createdAt_idx" ON "LearningBatchJob"("createdAt");

-- CreateIndex
CREATE INDEX "Message_conversationSessionId_idx" ON "Message"("conversationSessionId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationSessionId_fkey" FOREIGN KEY ("conversationSessionId") REFERENCES "ConversationSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationSession" ADD CONSTRAINT "ConversationSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationSession" ADD CONSTRAINT "ConversationSession_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningBatchJob" ADD CONSTRAINT "LearningBatchJob_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningBatchJob" ADD CONSTRAINT "LearningBatchJob_aiProviderId_fkey" FOREIGN KEY ("aiProviderId") REFERENCES "AiProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
