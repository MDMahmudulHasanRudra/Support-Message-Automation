-- Mood Detection (MOOD_DETECTION.md). Additive: four new, empty tables and two enums. Nothing
-- existing is altered and nothing is backfilled — the feature is off until an admin enables it on
-- Settings → Mood Detection, and an absent settings row means "off, with the defaults".
--
-- CustomerMoodEvent  one row per customer message that carried an emotional signal (the
--                    pipeline's deterministic pre-filter decides; ordinary messages write nothing).
--                    messageId is UNIQUE: the idempotency guard against replays and redeliveries.
--                    It references the Message and copies no text.
-- MoodAlert          one escalation of one customer in one group — the cooldown unit.
-- MoodAlertAction    one configured action of one alert, (alertId, action) UNIQUE, retried alone.
--
-- Every new table is small and new, so plain CREATE INDEX is fine here (the CONCURRENTLY escape
-- hatch is only for indexes on Message/OutboundMessage).

-- CreateEnum
CREATE TYPE "MoodEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'ANALYZED', 'FAILED');

-- CreateEnum
CREATE TYPE "MoodAlertActionStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "MoodDetectionSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "analyzeText" BOOLEAN NOT NULL DEFAULT true,
    "analyzeEmoji" BOOLEAN NOT NULL DEFAULT true,
    "analyzeStickers" BOOLEAN NOT NULL DEFAULT true,
    "useAiClassification" BOOLEAN NOT NULL DEFAULT false,
    "sensitivity" TEXT NOT NULL DEFAULT 'BALANCED',
    "minConfidence" INTEGER NOT NULL DEFAULT 80,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 30,
    "internalGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "policies" JSONB,
    "unassignedMention" TEXT NOT NULL DEFAULT 'OPTED_IN',
    "skipCustomerMessageWhenUnassigned" BOOLEAN NOT NULL DEFAULT false,
    "requireHumanHours" INTEGER NOT NULL DEFAULT 24,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoodDetectionSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMoodEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "messageId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "whatsappGroupId" TEXT NOT NULL,
    "customerKey" TEXT NOT NULL,
    "messageAt" TIMESTAMP(3) NOT NULL,
    "mood" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "scores" JSONB,
    "signals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "previousMood" TEXT,
    "level" INTEGER NOT NULL DEFAULT 0,
    "aiRequested" BOOLEAN NOT NULL DEFAULT false,
    "aiUsed" BOOLEAN NOT NULL DEFAULT false,
    "triggered" BOOLEAN NOT NULL DEFAULT false,
    "decisionNote" TEXT,
    "status" "MoodEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "analyzedAt" TIMESTAMP(3),
    "alertId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerMoodEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoodAlert" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "whatsappGroupId" TEXT NOT NULL,
    "customerKey" TEXT NOT NULL,
    "mood" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "priority" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "signals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstMessageId" TEXT NOT NULL,
    "latestMessageId" TEXT NOT NULL,
    "triggerCount" INTEGER NOT NULL DEFAULT 1,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cooldownUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoodAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoodAlertAction" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "alertId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" "MoodAlertActionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "lastError" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoodAlertAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MoodDetectionSettings_projectId_key" ON "MoodDetectionSettings"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMoodEvent_messageId_key" ON "CustomerMoodEvent"("messageId");

-- CreateIndex
CREATE INDEX "CustomerMoodEvent_status_scheduledAt_idx" ON "CustomerMoodEvent"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "CustomerMoodEvent_whatsappGroupId_customerKey_messageAt_idx" ON "CustomerMoodEvent"("whatsappGroupId", "customerKey", "messageAt");

-- CreateIndex
CREATE INDEX "CustomerMoodEvent_groupId_messageAt_idx" ON "CustomerMoodEvent"("groupId", "messageAt");

-- CreateIndex
CREATE INDEX "CustomerMoodEvent_projectId_messageAt_idx" ON "CustomerMoodEvent"("projectId", "messageAt");

-- CreateIndex
CREATE INDEX "MoodAlert_whatsappGroupId_customerKey_cooldownUntil_idx" ON "MoodAlert"("whatsappGroupId", "customerKey", "cooldownUntil");

-- CreateIndex
CREATE INDEX "MoodAlert_groupId_openedAt_idx" ON "MoodAlert"("groupId", "openedAt");

-- CreateIndex
CREATE INDEX "MoodAlert_projectId_openedAt_idx" ON "MoodAlert"("projectId", "openedAt");

-- CreateIndex
CREATE INDEX "MoodAlertAction_status_scheduledAt_idx" ON "MoodAlertAction"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "MoodAlertAction_alertId_action_key" ON "MoodAlertAction"("alertId", "action");

-- AddForeignKey
ALTER TABLE "MoodDetectionSettings" ADD CONSTRAINT "MoodDetectionSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMoodEvent" ADD CONSTRAINT "CustomerMoodEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMoodEvent" ADD CONSTRAINT "CustomerMoodEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMoodEvent" ADD CONSTRAINT "CustomerMoodEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMoodEvent" ADD CONSTRAINT "CustomerMoodEvent_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMoodEvent" ADD CONSTRAINT "CustomerMoodEvent_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "MoodAlert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodAlert" ADD CONSTRAINT "MoodAlert_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodAlert" ADD CONSTRAINT "MoodAlert_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodAlert" ADD CONSTRAINT "MoodAlert_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodAlertAction" ADD CONSTRAINT "MoodAlertAction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodAlertAction" ADD CONSTRAINT "MoodAlertAction_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "MoodAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 7 integrity (MULTI_PROJECT_PLAN.md §10.7): a child row's parent must be in the same project,
-- and no row ever changes project.
CREATE CONSTRAINT TRIGGER "CustomerMoodEvent_messageId_same_project" AFTER INSERT OR UPDATE OF "messageId", "projectId" ON "CustomerMoodEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Message', 'messageId');
CREATE CONSTRAINT TRIGGER "CustomerMoodEvent_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "CustomerMoodEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "CustomerMoodEvent_groupId_same_project" AFTER INSERT OR UPDATE OF "groupId", "projectId" ON "CustomerMoodEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppGroup', 'groupId');
CREATE CONSTRAINT TRIGGER "CustomerMoodEvent_alertId_same_project" AFTER INSERT OR UPDATE OF "alertId", "projectId" ON "CustomerMoodEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('MoodAlert', 'alertId');
CREATE CONSTRAINT TRIGGER "MoodAlert_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "MoodAlert" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "MoodAlert_groupId_same_project" AFTER INSERT OR UPDATE OF "groupId", "projectId" ON "MoodAlert" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppGroup', 'groupId');
CREATE CONSTRAINT TRIGGER "MoodAlertAction_alertId_same_project" AFTER INSERT OR UPDATE OF "alertId", "projectId" ON "MoodAlertAction" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('MoodAlert', 'alertId');

CREATE TRIGGER "MoodDetectionSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "MoodDetectionSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "CustomerMoodEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "CustomerMoodEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "MoodAlert_projectId_immutable" BEFORE UPDATE OF "projectId" ON "MoodAlert" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "MoodAlertAction_projectId_immutable" BEFORE UPDATE OF "projectId" ON "MoodAlertAction" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
