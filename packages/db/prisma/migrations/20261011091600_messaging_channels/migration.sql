-- Messaging channels beyond WhatsApp: Facebook Messenger, Instagram DM, Telegram (OMNICHANNEL.md).
--
-- Additive only: nine new enums and four new, empty, project-scoped tables. No existing table,
-- column, index or row is touched — WhatsApp's Message / WhatsAppGroup / OutboundMessage are
-- deliberately left alone, because ~40 readers (Team Report, attendance, support response,
-- escalation, …) assume every Message row is WhatsApp. The unified inbox reads both.
--
-- Safe on a live database: creating empty tables takes no lock on anything existing.
-- Rollback (before any channel is connected): drop the four tables and nine types. After channels
-- are in use, roll FORWARD instead — the tables hold customers' conversations.

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('MESSENGER', 'INSTAGRAM', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "ChannelConnectionStatus" AS ENUM ('SETUP_REQUIRED', 'CONNECTED', 'ERROR', 'NEEDS_RECONNECT', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ChannelEventStatus" AS ENUM ('PENDING', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "ChannelMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "ChannelSenderType" AS ENUM ('CUSTOMER', 'AGENT', 'AI', 'BUSINESS');

-- CreateEnum
CREATE TYPE "ChannelDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ChannelContentType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'FILE', 'STICKER', 'LOCATION', 'CONTACT', 'SHARE', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "ChannelThreadKind" AS ENUM ('DIRECT', 'GROUP');

-- CreateEnum
CREATE TYPE "ChannelConversationStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ChannelAiOutcome" AS ENUM ('REPLIED', 'HANDED_OVER', 'SKIPPED');

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "type" "ChannelType" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ChannelConnectionStatus" NOT NULL DEFAULT 'SETUP_REQUIRED',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "webhookKey" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "externalAccountName" TEXT,
    "externalUsername" TEXT,
    "pageId" TEXT,
    "appId" TEXT,
    "accessTokenCiphertext" TEXT,
    "appSecretCiphertext" TEXT,
    "verifyTokenCiphertext" TEXT,
    "webhookSecretCiphertext" TEXT,
    "aiAutomationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "humanAgentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webhookVerifiedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "credentialsUpdatedAt" TIMESTAMP(3),
    "credentialsUpdatedByUsername" TEXT,
    "createdByUsername" TEXT,
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelConversation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "connectionId" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "externalThreadId" TEXT NOT NULL,
    "kind" "ChannelThreadKind" NOT NULL DEFAULT 'DIRECT',
    "title" TEXT,
    "customerExternalId" TEXT,
    "customerName" TEXT,
    "customerUsername" TEXT,
    "status" "ChannelConversationStatus" NOT NULL DEFAULT 'OPEN',
    "assignedUserId" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "lastMessageDirection" "ChannelMessageDirection",
    "lastInboundAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "aiSuppressedUntil" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMessage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "conversationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "direction" "ChannelMessageDirection" NOT NULL,
    "senderType" "ChannelSenderType" NOT NULL,
    "senderExternalId" TEXT,
    "senderName" TEXT,
    "externalMessageId" TEXT,
    "text" TEXT,
    "contentType" "ChannelContentType" NOT NULL DEFAULT 'TEXT',
    "attachments" JSONB,
    "replyToExternalId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deliveryStatus" "ChannelDeliveryStatus",
    "idempotencyKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "sendingStartedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "messagingType" TEXT,
    "messagingTag" TEXT,
    "createdByUserId" TEXT,
    "aiClaimedAt" TIMESTAMP(3),
    "aiOutcome" "ChannelAiOutcome",
    "aiReason" TEXT,
    "aiConfidence" DOUBLE PRECISION,
    "aiModelId" TEXT,
    "aiReplyMessageId" TEXT,

    CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelInboundEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "connectionId" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "status" "ChannelEventStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "note" TEXT,

    CONSTRAINT "ChannelInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_webhookKey_key" ON "ChannelConnection"("webhookKey");

-- CreateIndex
CREATE INDEX "ChannelConnection_projectId_type_idx" ON "ChannelConnection"("projectId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_projectId_type_externalAccountId_key" ON "ChannelConnection"("projectId", "type", "externalAccountId");

-- CreateIndex
CREATE INDEX "ChannelConversation_projectId_lastMessageAt_idx" ON "ChannelConversation"("projectId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "ChannelConversation_projectId_type_lastMessageAt_idx" ON "ChannelConversation"("projectId", "type", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConversation_projectId_connectionId_externalThreadId_key" ON "ChannelConversation"("projectId", "connectionId", "externalThreadId");

-- CreateIndex
CREATE INDEX "ChannelMessage_projectId_conversationId_occurredAt_idx" ON "ChannelMessage"("projectId", "conversationId", "occurredAt");

-- CreateIndex
CREATE INDEX "ChannelMessage_conversationId_direction_createdAt_idx" ON "ChannelMessage"("conversationId", "direction", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelMessage_deliveryStatus_nextAttemptAt_idx" ON "ChannelMessage"("deliveryStatus", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMessage_projectId_connectionId_externalMessageId_key" ON "ChannelMessage"("projectId", "connectionId", "externalMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMessage_projectId_idempotencyKey_key" ON "ChannelMessage"("projectId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ChannelInboundEvent_status_receivedAt_idx" ON "ChannelInboundEvent"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelInboundEvent_projectId_connectionId_dedupKey_key" ON "ChannelInboundEvent"("projectId", "connectionId", "dedupKey");

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConversation" ADD CONSTRAINT "ChannelConversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConversation" ADD CONSTRAINT "ChannelConversation_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConversation" ADD CONSTRAINT "ChannelConversation_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChannelConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelInboundEvent" ADD CONSTRAINT "ChannelInboundEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelInboundEvent" ADD CONSTRAINT "ChannelInboundEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Phase 7 integrity: no row changes project, and every project-owned row it points at is in its own
-- project. (User columns point at platform users, which have no project.)
CREATE TRIGGER "ChannelConnection_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ChannelConnection" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ChannelConversation_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ChannelConversation" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ChannelMessage_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ChannelMessage" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ChannelInboundEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ChannelInboundEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "ChannelConversation_connectionId_same_project" AFTER INSERT OR UPDATE OF "connectionId", "projectId" ON "ChannelConversation" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConnection', 'connectionId');
CREATE CONSTRAINT TRIGGER "ChannelMessage_conversationId_same_project" AFTER INSERT OR UPDATE OF "conversationId", "projectId" ON "ChannelMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'conversationId');
CREATE CONSTRAINT TRIGGER "ChannelMessage_connectionId_same_project" AFTER INSERT OR UPDATE OF "connectionId", "projectId" ON "ChannelMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConnection', 'connectionId');
CREATE CONSTRAINT TRIGGER "ChannelInboundEvent_connectionId_same_project" AFTER INSERT OR UPDATE OF "connectionId", "projectId" ON "ChannelInboundEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConnection', 'connectionId');
