/*
  Warnings:

  - You are about to drop the `HealthCheck` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INCOMING', 'OUTGOING', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RuleType" AS ENUM ('TEAM_FILTER', 'DEFAULT_IGNORE', 'LAST_SENDER', 'EXCEPTION', 'SUPPORT_ESCALATION', 'AUTO_REPLY', 'GENERIC');

-- CreateEnum
CREATE TYPE "MatchType" AS ENUM ('EXACT', 'CONTAINS', 'KEYWORDS', 'REGEX', 'ALWAYS');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('IGNORE', 'TAG', 'AUTO_REPLY', 'SUPPORT_REQUIRED', 'NOTIFY_TEAMS', 'NOTIFY_WHATSAPP', 'FORWARD', 'STOP_PROCESSING');

-- CreateEnum
CREATE TYPE "OutboundMessageStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'RATE_LIMITED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TEAMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'RETRYING');

-- CreateEnum
CREATE TYPE "WorkerCommandType" AS ENUM ('GET_QR', 'RECONNECT', 'SEND_LIVE_TEST', 'RESYNC_GROUPS');

-- CreateEnum
CREATE TYPE "WorkerCommandStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "AutomationMode" AS ENUM ('MANUAL_ONLY', 'SAFE_AUTO_REPLY', 'FULL_RULE_AUTOMATION');

-- CreateEnum
CREATE TYPE "TeamMemberStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "WhatsAppAccountStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'RECONNECTING', 'AUTHENTICATION_REQUIRED', 'SESSION_ERROR', 'OUTBOUND_PAUSED', 'RATE_LIMITED', 'ERROR');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- DropTable
DROP TABLE "HealthCheck";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppAccount" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "status" "WhatsAppAccountStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "qrCode" TEXT,
    "qrUpdatedAt" TIMESTAMP(3),
    "lastConnectedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "sessionDataPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppGroup" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "whatsappGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isMonitored" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalTeamMember" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "department" TEXT,
    "status" "TeamMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InternalTeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT,
    "whatsappMessageId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "senderPhone" TEXT NOT NULL,
    "senderName" TEXT,
    "isFromTeamMember" BOOLEAN NOT NULL DEFAULT false,
    "direction" "MessageDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "normalizedBody" TEXT NOT NULL,
    "timestampWa" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "RuleType" NOT NULL,
    "matchType" "MatchType" NOT NULL,
    "matchValue" TEXT,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
    "cooldownSeconds" INTEGER,
    "replyMessage" TEXT,
    "replyDelayMinMs" INTEGER,
    "replyDelayMaxMs" INTEGER,
    "executionCount" INTEGER NOT NULL DEFAULT 0,
    "lastExecutedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationExecution" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "ruleId" TEXT,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actionsExecuted" JSONB NOT NULL,
    "decision" TEXT NOT NULL,
    "reasonTrace" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "relatedMessageId" TEXT,
    "ruleId" TEXT,
    "actionType" "ActionType" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "OutboundMessageStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "delayMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "destination" TEXT NOT NULL,
    "relatedMessageId" TEXT,
    "relatedRuleId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerCommand" (
    "id" TEXT NOT NULL,
    "type" "WorkerCommandType" NOT NULL,
    "payload" JSONB,
    "status" "WorkerCommandStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WorkerCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingCheckpoint" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lastProcessedTimestampWa" TIMESTAMP(3),
    "lastProcessedMessageId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "mode" "AutomationMode" NOT NULL DEFAULT 'SAFE_AUTO_REPLY',
    "automationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maxRepliesPerClientPerHour" INTEGER NOT NULL DEFAULT 3,
    "maxRepliesPerClientPerDay" INTEGER NOT NULL DEFAULT 10,
    "globalMaxPerMinute" INTEGER NOT NULL DEFAULT 5,
    "globalMaxPerHour" INTEGER NOT NULL DEFAULT 100,
    "globalMaxPerDay" INTEGER NOT NULL DEFAULT 500,
    "rateLimitingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultReplyDelayMinMs" INTEGER NOT NULL DEFAULT 3000,
    "defaultReplyDelayMaxMs" INTEGER NOT NULL DEFAULT 15000,
    "retryMaxAttempts" INTEGER NOT NULL DEFAULT 3,
    "retryIntervalsMs" JSONB NOT NULL DEFAULT '[30000,300000,900000]',
    "teamsWebhookUrl" TEXT,
    "whatsappNotificationGroupId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "scope" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppGroup_accountId_whatsappGroupId_key" ON "WhatsAppGroup"("accountId", "whatsappGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "InternalTeamMember_phoneNumber_key" ON "InternalTeamMember"("phoneNumber");

-- CreateIndex
CREATE INDEX "Message_chatId_timestampWa_idx" ON "Message"("chatId", "timestampWa");

-- CreateIndex
CREATE INDEX "Message_groupId_timestampWa_idx" ON "Message"("groupId", "timestampWa");

-- CreateIndex
CREATE INDEX "Message_processingStatus_idx" ON "Message"("processingStatus");

-- CreateIndex
CREATE INDEX "Message_senderPhone_idx" ON "Message"("senderPhone");

-- CreateIndex
CREATE UNIQUE INDEX "Message_accountId_whatsappMessageId_key" ON "Message"("accountId", "whatsappMessageId");

-- CreateIndex
CREATE INDEX "AutomationRule_status_priority_idx" ON "AutomationRule"("status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationExecution_idempotencyKey_key" ON "AutomationExecution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AutomationExecution_messageId_idx" ON "AutomationExecution"("messageId");

-- CreateIndex
CREATE INDEX "AutomationExecution_ruleId_idx" ON "AutomationExecution"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_idempotencyKey_key" ON "OutboundMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboundMessage_status_scheduledAt_idx" ON "OutboundMessage"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "OutboundMessage_toPhone_sentAt_idx" ON "OutboundMessage"("toPhone", "sentAt");

-- CreateIndex
CREATE INDEX "OutboundMessage_sentAt_idx" ON "OutboundMessage"("sentAt");

-- CreateIndex
CREATE INDEX "Notification_status_idx" ON "Notification"("status");

-- CreateIndex
CREATE INDEX "WorkerCommand_status_createdAt_idx" ON "WorkerCommand"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingCheckpoint_accountId_key" ON "ProcessingCheckpoint"("accountId");

-- CreateIndex
CREATE INDEX "SystemLog_createdAt_idx" ON "SystemLog"("createdAt");

-- CreateIndex
CREATE INDEX "SystemLog_level_idx" ON "SystemLog"("level");

-- AddForeignKey
ALTER TABLE "WhatsAppGroup" ADD CONSTRAINT "WhatsAppGroup_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_relatedMessageId_fkey" FOREIGN KEY ("relatedMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_relatedMessageId_fkey" FOREIGN KEY ("relatedMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_relatedRuleId_fkey" FOREIGN KEY ("relatedRuleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingCheckpoint" ADD CONSTRAINT "ProcessingCheckpoint_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
