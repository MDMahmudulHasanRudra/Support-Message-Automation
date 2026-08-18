-- CreateEnum
CREATE TYPE "SupportActivityCountingMode" AS ENUM ('UNIQUE_GROUP', 'EVERY_ACTIVITY', 'PER_TEAM_MEMBER');

-- CreateEnum
CREATE TYPE "SupportActivityCountingPeriod" AS ENUM ('DAILY');

-- CreateEnum
CREATE TYPE "SupportActivityTriggerType" AS ENUM ('KEYWORD_MATCH');

-- CreateEnum
CREATE TYPE "SupportKeywordMatchMode" AS ENUM ('CONTAINS', 'EXACT');

-- CreateTable
CREATE TABLE "SupportActivitySettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "countingMode" "SupportActivityCountingMode" NOT NULL DEFAULT 'EVERY_ACTIVITY',
    "countingPeriod" "SupportActivityCountingPeriod" NOT NULL DEFAULT 'DAILY',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportActivitySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportKeyword" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "matchMode" "SupportKeywordMatchMode" NOT NULL DEFAULT 'CONTAINS',
    "caseSensitive" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "triggerType" "SupportActivityTriggerType" NOT NULL DEFAULT 'KEYWORD_MATCH',
    "appliesToAllGroups" BOOLEAN NOT NULL DEFAULT true,
    "appliesToAllTeamMembers" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportRuleKeyword" (
    "ruleId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportRuleKeyword_pkey" PRIMARY KEY ("ruleId","keywordId")
);

-- CreateTable
CREATE TABLE "SupportRuleGroup" (
    "ruleId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportRuleGroup_pkey" PRIMARY KEY ("ruleId","groupId")
);

-- CreateTable
CREATE TABLE "SupportRuleTeamMember" (
    "ruleId" TEXT NOT NULL,
    "teamMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportRuleTeamMember_pkey" PRIMARY KEY ("ruleId","teamMemberId")
);

-- CreateTable
CREATE TABLE "SupportActivity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "teamMemberId" TEXT,
    "ruleId" TEXT,
    "keywordId" TEXT,
    "messageId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportRule_isActive_triggerType_idx" ON "SupportRule"("isActive", "triggerType");

-- CreateIndex
CREATE UNIQUE INDEX "SupportActivity_messageId_key" ON "SupportActivity"("messageId");

-- CreateIndex
CREATE INDEX "SupportActivity_accountId_occurredAt_idx" ON "SupportActivity"("accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "SupportActivity_accountId_groupId_occurredAt_idx" ON "SupportActivity"("accountId", "groupId", "occurredAt");

-- CreateIndex
CREATE INDEX "SupportActivity_accountId_teamMemberId_occurredAt_idx" ON "SupportActivity"("accountId", "teamMemberId", "occurredAt");

-- CreateIndex
CREATE INDEX "SupportActivity_ruleId_idx" ON "SupportActivity"("ruleId");

-- AddForeignKey
ALTER TABLE "SupportRuleKeyword" ADD CONSTRAINT "SupportRuleKeyword_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SupportRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRuleKeyword" ADD CONSTRAINT "SupportRuleKeyword_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "SupportKeyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRuleGroup" ADD CONSTRAINT "SupportRuleGroup_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SupportRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRuleGroup" ADD CONSTRAINT "SupportRuleGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRuleTeamMember" ADD CONSTRAINT "SupportRuleTeamMember_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SupportRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRuleTeamMember" ADD CONSTRAINT "SupportRuleTeamMember_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportActivity" ADD CONSTRAINT "SupportActivity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportActivity" ADD CONSTRAINT "SupportActivity_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportActivity" ADD CONSTRAINT "SupportActivity_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportActivity" ADD CONSTRAINT "SupportActivity_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SupportRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportActivity" ADD CONSTRAINT "SupportActivity_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "SupportKeyword"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportActivity" ADD CONSTRAINT "SupportActivity_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
