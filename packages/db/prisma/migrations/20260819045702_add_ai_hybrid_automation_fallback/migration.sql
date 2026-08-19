-- CreateEnum
CREATE TYPE "AiFallbackOutcome" AS ENUM ('AI_REPLIED', 'HUMAN_FALLBACK');

-- CreateEnum
CREATE TYPE "EvidenceResponseSource" AS ENUM ('EXISTING_RULE', 'HUMAN', 'AI', 'UNRESOLVED');

-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN     "autoResponseConfidenceThreshold" INTEGER NOT NULL DEFAULT 90;

-- AlterTable
ALTER TABLE "PatternCandidateEvidence" ADD COLUMN     "responseSource" "EvidenceResponseSource" NOT NULL DEFAULT 'UNRESOLVED';

-- AlterTable
ALTER TABLE "WhatsAppGroup" ADD COLUMN     "aiAutomationEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AiFallbackDecision" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT,
    "aiProviderId" TEXT,
    "modelId" TEXT,
    "intent" TEXT,
    "confidenceScore" INTEGER,
    "responseText" TEXT,
    "outcome" "AiFallbackOutcome" NOT NULL,
    "reason" TEXT,
    "outboundMessageId" TEXT,
    "notificationId" TEXT,
    "tokensUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiFallbackDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiFallbackDecision_messageId_key" ON "AiFallbackDecision"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "AiFallbackDecision_outboundMessageId_key" ON "AiFallbackDecision"("outboundMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "AiFallbackDecision_notificationId_key" ON "AiFallbackDecision"("notificationId");

-- CreateIndex
CREATE INDEX "AiFallbackDecision_accountId_createdAt_idx" ON "AiFallbackDecision"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "AiFallbackDecision_outcome_createdAt_idx" ON "AiFallbackDecision"("outcome", "createdAt");

-- AddForeignKey
ALTER TABLE "AiFallbackDecision" ADD CONSTRAINT "AiFallbackDecision_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFallbackDecision" ADD CONSTRAINT "AiFallbackDecision_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFallbackDecision" ADD CONSTRAINT "AiFallbackDecision_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFallbackDecision" ADD CONSTRAINT "AiFallbackDecision_aiProviderId_fkey" FOREIGN KEY ("aiProviderId") REFERENCES "AiProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFallbackDecision" ADD CONSTRAINT "AiFallbackDecision_outboundMessageId_fkey" FOREIGN KEY ("outboundMessageId") REFERENCES "OutboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFallbackDecision" ADD CONSTRAINT "AiFallbackDecision_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
