-- Unified Inbox V3, part 1: conversation lifecycle and WhatsApp conversation state (feature UNIFIED_INBOX_V3,
-- off by default; packages/shared/src/conversationLifecycle.ts). Additive only: new enum values, nullable
-- columns, two new tables. No Message row is copied or changed. The retired Teams tables are left alone.

-- CreateEnum
CREATE TYPE "ConversationLifecycleStatus" AS ENUM ('OPEN', 'PENDING', 'SNOOZED', 'RESOLVED');

-- AlterEnum (PostgreSQL 12+: several values in one migration is fine; none is used below in this transaction)
ALTER TYPE "ChannelConversationStatus" ADD VALUE 'PENDING';
ALTER TYPE "ChannelConversationStatus" ADD VALUE 'SNOOZED';
-- AlterTable
ALTER TABLE "ChannelConversation" ADD COLUMN     "resolvedById" TEXT,
ADD COLUMN     "snoozedUntil" TIMESTAMP(3),
ADD COLUMN     "statusChangedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ConversationEvent" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "chatId" TEXT,
ADD COLUMN     "context" JSONB,
ALTER COLUMN "channelConversationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "WhatsAppConversationState" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "accountId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "conversationType" TEXT NOT NULL,
    "status" "ConversationLifecycleStatus" NOT NULL DEFAULT 'OPEN',
    "snoozedUntil" TIMESTAMP(3),
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedUserId" TEXT,
    "assignedTeamId" TEXT,
    "lastActivityAt" TIMESTAMP(3),
    "lastCustomerMessageAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppConversationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxLifecycleSettings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "reopenResolvedOnCustomerMessage" BOOLEAN NOT NULL DEFAULT true,
    "reopenSnoozedOnCustomerMessage" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxLifecycleSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppConversationState_projectId_status_snoozedUntil_idx" ON "WhatsAppConversationState"("projectId", "status", "snoozedUntil");

-- CreateIndex
CREATE INDEX "WhatsAppConversationState_projectId_assignedUserId_idx" ON "WhatsAppConversationState"("projectId", "assignedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConversationState_projectId_accountId_chatId_key" ON "WhatsAppConversationState"("projectId", "accountId", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "InboxLifecycleSettings_projectId_key" ON "InboxLifecycleSettings"("projectId");

-- CreateIndex
CREATE INDEX "ConversationEvent_projectId_accountId_chatId_createdAt_idx" ON "ConversationEvent"("projectId", "accountId", "chatId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppConversationState" ADD CONSTRAINT "WhatsAppConversationState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppConversationState" ADD CONSTRAINT "WhatsAppConversationState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppConversationState" ADD CONSTRAINT "WhatsAppConversationState_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppConversationState" ADD CONSTRAINT "WhatsAppConversationState_assignedTeamId_fkey" FOREIGN KEY ("assignedTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxLifecycleSettings" ADD CONSTRAINT "InboxLifecycleSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The event kinds: the original three plus the lifecycle kinds (conversationLifecycle.ts LIFECYCLE_EVENT_KINDS).
ALTER TABLE "ConversationEvent" DROP CONSTRAINT "ConversationEvent_kind_known";
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_kind_known" CHECK ("kind" IN ('ASSIGNEE', 'TEAM', 'STATUS', 'REOPEN', 'PENDING', 'RESOLVE', 'SNOOZE', 'UNSNOOZE'));

-- A conversation event names exactly one conversation: a channel conversation, or a WhatsApp chat.
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_one_conversation" CHECK (
  ("channelConversationId" IS NOT NULL AND "accountId" IS NULL AND "chatId" IS NULL)
  OR ("channelConversationId" IS NULL AND "accountId" IS NOT NULL AND "chatId" IS NOT NULL)
);

-- The state's own invariants. (status::text, not the enum literal: a value added above cannot be used in
-- the same transaction.)
ALTER TABLE "WhatsAppConversationState" ADD CONSTRAINT "WhatsAppConversationState_type_check" CHECK ("conversationType" IN ('GROUP', 'PERSONAL'));
ALTER TABLE "WhatsAppConversationState" ADD CONSTRAINT "WhatsAppConversationState_snooze_check" CHECK (("status"::text = 'SNOOZED') = ("snoozedUntil" IS NOT NULL));
ALTER TABLE "ChannelConversation" ADD CONSTRAINT "ChannelConversation_snooze_check" CHECK ("status"::text <> 'SNOOZED' OR "snoozedUntil" IS NOT NULL);

-- Database integrity (MULTI_PROJECT_PLAN.md §10.7).
CREATE CONSTRAINT TRIGGER "ConversationEvent_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "ConversationEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "WhatsAppConversationState_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "WhatsAppConversationState" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "WhatsAppConversationState_assignedTeamId_same_project" AFTER INSERT OR UPDATE OF "assignedTeamId", "projectId" ON "WhatsAppConversationState" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Team', 'assignedTeamId');
CREATE TRIGGER "WhatsAppConversationState_projectId_immutable" BEFORE UPDATE OF "projectId" ON "WhatsAppConversationState" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "InboxLifecycleSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "InboxLifecycleSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- The snooze loop reads only snoozed channel conversations.
CREATE INDEX "ChannelConversation_snoozed_idx" ON "ChannelConversation"("projectId", "snoozedUntil") WHERE "snoozedUntil" IS NOT NULL;
