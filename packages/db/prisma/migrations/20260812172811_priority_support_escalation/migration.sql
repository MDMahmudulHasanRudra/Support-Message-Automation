-- CreateEnum
CREATE TYPE "SupportPriority" AS ENUM ('P1', 'P2', 'P3');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('NEW', 'MONITORING', 'WAITING_FOR_HUMAN', 'SECOND_ALERT', 'MEMBER_ESCALATED', 'ADMIN_ESCALATED', 'FOLLOW_UP', 'HUMAN_REPLIED', 'RESOLVED', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EscalationEventType" AS ENUM ('FIRST_NOTIFICATION', 'SECOND_NOTIFICATION', 'MEMBER_NOTIFICATION', 'ADMIN_NOTIFICATION', 'FOLLOW_UP', 'HUMAN_REPLIED', 'RESOLVED', 'PAUSED', 'RESUMED', 'MANUAL_ESCALATE', 'REASSIGNED', 'RESET');

-- CreateEnum
CREATE TYPE "EscalationRecipientType" AS ENUM ('GROUP', 'MEMBER', 'ADMIN', 'SYSTEM');

-- AlterTable
ALTER TABLE "WhatsAppGroup" ADD COLUMN     "assignedTeamMemberId" TEXT,
ADD COLUMN     "escalationMonitoringEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "priority" "SupportPriority";

-- CreateTable
CREATE TABLE "SupportPriorityPolicy" (
    "id" TEXT NOT NULL,
    "priority" "SupportPriority" NOT NULL,
    "firstAlertMinutes" INTEGER NOT NULL,
    "secondAlertMinutes" INTEGER NOT NULL,
    "memberEscalationMinutes" INTEGER NOT NULL,
    "adminEscalationMinutes" INTEGER NOT NULL,
    "followUpIntervalMinutes" INTEGER NOT NULL,
    "maxEscalations" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportPriorityPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportEscalationSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "escalationAdminId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportEscalationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportEscalationCase" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "clientPhone" TEXT NOT NULL,
    "priority" "SupportPriority" NOT NULL,
    "status" "EscalationStatus" NOT NULL DEFAULT 'NEW',
    "triggerMessageId" TEXT NOT NULL,
    "lastCustomerMessageAt" TIMESTAMP(3) NOT NULL,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "assignedTeamMemberId" TEXT,
    "firstAlertMinutes" INTEGER NOT NULL,
    "secondAlertMinutes" INTEGER NOT NULL,
    "memberEscalationMinutes" INTEGER NOT NULL,
    "adminEscalationMinutes" INTEGER NOT NULL,
    "followUpIntervalMinutes" INTEGER NOT NULL,
    "maxEscalations" INTEGER NOT NULL,
    "nextCheckAt" TIMESTAMP(3) NOT NULL,
    "humanRepliedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "pausedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportEscalationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportEscalationEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "eventType" "EscalationEventType" NOT NULL,
    "recipientType" "EscalationRecipientType" NOT NULL,
    "recipientKey" TEXT NOT NULL,
    "recipientLabel" TEXT NOT NULL,
    "notificationId" TEXT,
    "triggeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportEscalationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportPriorityPolicy_priority_key" ON "SupportPriorityPolicy"("priority");

-- CreateIndex
CREATE INDEX "SupportEscalationCase_status_nextCheckAt_idx" ON "SupportEscalationCase"("status", "nextCheckAt");

-- CreateIndex
CREATE INDEX "SupportEscalationCase_groupId_idx" ON "SupportEscalationCase"("groupId");

-- CreateIndex
CREATE INDEX "SupportEscalationCase_chatId_idx" ON "SupportEscalationCase"("chatId");

-- CreateIndex
CREATE INDEX "SupportEscalationEvent_caseId_idx" ON "SupportEscalationEvent"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportEscalationEvent_caseId_level_eventType_recipientKey_key" ON "SupportEscalationEvent"("caseId", "level", "eventType", "recipientKey");

-- AddForeignKey
ALTER TABLE "WhatsAppGroup" ADD CONSTRAINT "WhatsAppGroup_assignedTeamMemberId_fkey" FOREIGN KEY ("assignedTeamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportEscalationSettings" ADD CONSTRAINT "SupportEscalationSettings_escalationAdminId_fkey" FOREIGN KEY ("escalationAdminId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportEscalationCase" ADD CONSTRAINT "SupportEscalationCase_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportEscalationCase" ADD CONSTRAINT "SupportEscalationCase_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportEscalationCase" ADD CONSTRAINT "SupportEscalationCase_triggerMessageId_fkey" FOREIGN KEY ("triggerMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportEscalationCase" ADD CONSTRAINT "SupportEscalationCase_assignedTeamMemberId_fkey" FOREIGN KEY ("assignedTeamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportEscalationCase" ADD CONSTRAINT "SupportEscalationCase_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportEscalationEvent" ADD CONSTRAINT "SupportEscalationEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "SupportEscalationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportEscalationEvent" ADD CONSTRAINT "SupportEscalationEvent_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportEscalationEvent" ADD CONSTRAINT "SupportEscalationEvent_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
