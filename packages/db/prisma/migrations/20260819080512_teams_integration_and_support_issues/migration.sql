-- CreateEnum
CREATE TYPE "TeamsAccountStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "SupportIssueStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_DEVELOPER', 'RESOLUTION_DETECTED', 'WAITING_CUSTOMER_CHECK', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IssueResolutionOutcome" AS ENUM ('NOTIFIED', 'SKIPPED_ALREADY_RESOLVED', 'SKIPPED_NO_PHONE_MAPPING', 'SKIPPED_NOTIFICATIONS_DISABLED', 'SKIPPED_MANUALLY_IGNORED', 'SKIPPED_ACCOUNT_UNAVAILABLE');

-- AlterEnum
ALTER TYPE "WhatsAppServiceKey" ADD VALUE 'TEAMS_RESOLUTION_NOTIFY';

-- AlterEnum
ALTER TYPE "WorkerCommandType" ADD VALUE 'TEAMS_SYNC_NOW';

-- AlterTable
ALTER TABLE "InternalTeamMember" ADD COLUMN     "microsoftEmail" TEXT;

-- CreateTable
CREATE TABLE "TeamsAccount" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "tenantId" TEXT,
    "externalUserId" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "status" "TeamsAccountStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamsAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamsTeam" (
    "id" TEXT NOT NULL,
    "externalTeamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamsTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamsChannel" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "externalChannelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channelType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamsChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamsMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "senderExternalId" TEXT NOT NULL,
    "senderDisplayName" TEXT,
    "body" TEXT NOT NULL,
    "parentMessageId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamsResolutionKeyword" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "matchMode" "SupportKeywordMatchMode" NOT NULL DEFAULT 'CONTAINS',
    "caseSensitive" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamsResolutionKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamsResolutionRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamsResolutionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamsResolutionRuleKeyword" (
    "ruleId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamsResolutionRuleKeyword_pkey" PRIMARY KEY ("ruleId","keywordId")
);

-- CreateTable
CREATE TABLE "SupportIssue" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "clientPhone" TEXT NOT NULL,
    "title" TEXT,
    "supportExecutiveId" TEXT,
    "status" "SupportIssueStatus" NOT NULL DEFAULT 'OPEN',
    "triggerMessageId" TEXT,
    "teamsChannelId" TEXT,
    "teamsThreadExternalId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueResolutionEvent" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "teamsMessageId" TEXT NOT NULL,
    "matchedRuleId" TEXT,
    "matchedKeyword" TEXT,
    "outcome" "IssueResolutionOutcome" NOT NULL,
    "outboundMessageId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueResolutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamsIntegrationSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enableResolutionDetection" BOOLEAN NOT NULL DEFAULT true,
    "enableCustomerNotification" BOOLEAN NOT NULL DEFAULT false,
    "notificationTemplate" TEXT NOT NULL DEFAULT 'Hi {{customerName}}, your issue has been resolved by our support team. Thank you for your patience!',
    "pollingIntervalMinutes" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamsIntegrationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamsTeam_externalTeamId_key" ON "TeamsTeam"("externalTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamsChannel_teamId_externalChannelId_key" ON "TeamsChannel"("teamId", "externalChannelId");

-- CreateIndex
CREATE INDEX "TeamsMessage_channelId_sentAt_idx" ON "TeamsMessage"("channelId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "TeamsMessage_channelId_externalMessageId_key" ON "TeamsMessage"("channelId", "externalMessageId");

-- CreateIndex
CREATE INDEX "TeamsResolutionRule_isActive_idx" ON "TeamsResolutionRule"("isActive");

-- CreateIndex
CREATE INDEX "SupportIssue_status_idx" ON "SupportIssue"("status");

-- CreateIndex
CREATE INDEX "SupportIssue_accountId_chatId_idx" ON "SupportIssue"("accountId", "chatId");

-- CreateIndex
CREATE INDEX "SupportIssue_teamsChannelId_teamsThreadExternalId_idx" ON "SupportIssue"("teamsChannelId", "teamsThreadExternalId");

-- CreateIndex
CREATE INDEX "SupportIssue_supportExecutiveId_idx" ON "SupportIssue"("supportExecutiveId");

-- CreateIndex
CREATE UNIQUE INDEX "IssueResolutionEvent_outboundMessageId_key" ON "IssueResolutionEvent"("outboundMessageId");

-- CreateIndex
CREATE INDEX "IssueResolutionEvent_issueId_idx" ON "IssueResolutionEvent"("issueId");

-- CreateIndex
CREATE UNIQUE INDEX "IssueResolutionEvent_issueId_teamsMessageId_key" ON "IssueResolutionEvent"("issueId", "teamsMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "InternalTeamMember_microsoftEmail_key" ON "InternalTeamMember"("microsoftEmail");

-- AddForeignKey
ALTER TABLE "TeamsChannel" ADD CONSTRAINT "TeamsChannel_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "TeamsTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamsMessage" ADD CONSTRAINT "TeamsMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TeamsChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamsMessage" ADD CONSTRAINT "TeamsMessage_parentMessageId_fkey" FOREIGN KEY ("parentMessageId") REFERENCES "TeamsMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamsResolutionRuleKeyword" ADD CONSTRAINT "TeamsResolutionRuleKeyword_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "TeamsResolutionRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamsResolutionRuleKeyword" ADD CONSTRAINT "TeamsResolutionRuleKeyword_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "TeamsResolutionKeyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_supportExecutiveId_fkey" FOREIGN KEY ("supportExecutiveId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_triggerMessageId_fkey" FOREIGN KEY ("triggerMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_teamsChannelId_fkey" FOREIGN KEY ("teamsChannelId") REFERENCES "TeamsChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportIssue" ADD CONSTRAINT "SupportIssue_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueResolutionEvent" ADD CONSTRAINT "IssueResolutionEvent_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "SupportIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueResolutionEvent" ADD CONSTRAINT "IssueResolutionEvent_teamsMessageId_fkey" FOREIGN KEY ("teamsMessageId") REFERENCES "TeamsMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueResolutionEvent" ADD CONSTRAINT "IssueResolutionEvent_matchedRuleId_fkey" FOREIGN KEY ("matchedRuleId") REFERENCES "TeamsResolutionRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueResolutionEvent" ADD CONSTRAINT "IssueResolutionEvent_outboundMessageId_fkey" FOREIGN KEY ("outboundMessageId") REFERENCES "OutboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

