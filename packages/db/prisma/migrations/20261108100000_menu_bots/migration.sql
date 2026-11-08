-- Menu bots (MENU_BOTS.md, feature MENU_BOTS): a numbered menu a customer answers by typing a number. Additive only: two
-- enums and three new tables. No existing row is changed. Nothing answers anyone until a person switches a bot on.

CREATE TYPE "MenuBotStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');
CREATE TYPE "MenuSessionStatus" AS ENUM ('ACTIVE', 'ENDED', 'HANDED_OFF', 'EXPIRED');

CREATE TABLE "MenuBot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "name" TEXT NOT NULL,
    "status" "MenuBotStatus" NOT NULL DEFAULT 'DRAFT',
    "tree" JSONB NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startOnFirstMessage" BOOLEAN NOT NULL DEFAULT false,
    "onWhatsAppPersonal" BOOLEAN NOT NULL DEFAULT true,
    "onWhatsAppGroups" BOOLEAN NOT NULL DEFAULT false,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "invalidText" TEXT NOT NULL,
    "handoffText" TEXT NOT NULL,
    "backLabel" TEXT NOT NULL,
    "homeLabel" TEXT NOT NULL,
    "maxInvalid" INTEGER NOT NULL DEFAULT 2,
    "sessionMinutes" INTEGER NOT NULL DEFAULT 30,
    "quietMinutes" INTEGER NOT NULL DEFAULT 120,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuBot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MenuBot_name_length" CHECK (char_length("name") BETWEEN 1 AND 120),
    CONSTRAINT "MenuBot_max_invalid" CHECK ("maxInvalid" BETWEEN 1 AND 10),
    CONSTRAINT "MenuBot_session_minutes" CHECK ("sessionMinutes" BETWEEN 1 AND 1440),
    CONSTRAINT "MenuBot_quiet_minutes" CHECK ("quietMinutes" BETWEEN 0 AND 10080)
);

CREATE TABLE "MenuSession" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "botId" TEXT NOT NULL,
    "accountId" TEXT,
    "chatId" TEXT,
    "senderKey" TEXT,
    "channelConversationId" TEXT,
    "nodeId" TEXT NOT NULL,
    "path" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "status" "MenuSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "MenuSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MenuSession_one_kind" CHECK (("chatId" IS NULL) <> ("channelConversationId" IS NULL)),
    CONSTRAINT "MenuSession_whatsapp_sender" CHECK ("chatId" IS NULL OR "senderKey" IS NOT NULL),
    CONSTRAINT "MenuSession_ended_time" CHECK (("status" = 'ACTIVE') = ("endedAt" IS NULL))
);

CREATE TABLE "MenuEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "botId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "nodeId" TEXT,
    "nodeTitle" TEXT,
    "optionLabel" TEXT,
    "replyText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MenuEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MenuEvent_kind_known" CHECK ("kind" IN ('STARTED', 'CHOSE', 'BACK', 'RESTART', 'INVALID', 'HANDOFF', 'RELEASED'))
);

CREATE INDEX "MenuBot_projectId_status_idx" ON "MenuBot"("projectId", "status");
-- One running session per person per chat: two messages arriving together cannot open two.
CREATE UNIQUE INDEX "MenuSession_active_chat_key" ON "MenuSession"("projectId", "chatId", "senderKey") WHERE "status" = 'ACTIVE' AND "chatId" IS NOT NULL;
CREATE UNIQUE INDEX "MenuSession_active_channel_key" ON "MenuSession"("projectId", "channelConversationId") WHERE "status" = 'ACTIVE' AND "channelConversationId" IS NOT NULL;
CREATE INDEX "MenuSession_projectId_chatId_senderKey_endedAt_idx" ON "MenuSession"("projectId", "chatId", "senderKey", "endedAt");
CREATE INDEX "MenuSession_channelConversationId_endedAt_idx" ON "MenuSession"("channelConversationId", "endedAt");
CREATE INDEX "MenuSession_botId_startedAt_idx" ON "MenuSession"("botId", "startedAt");
-- One step per customer message: a replayed message answers from the row already written and never advances twice.
CREATE UNIQUE INDEX "MenuEvent_projectId_messageRef_key" ON "MenuEvent"("projectId", "messageRef");
CREATE INDEX "MenuEvent_botId_createdAt_idx" ON "MenuEvent"("botId", "createdAt");
CREATE INDEX "MenuEvent_sessionId_idx" ON "MenuEvent"("sessionId");

ALTER TABLE "MenuBot" ADD CONSTRAINT "MenuBot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MenuBot" ADD CONSTRAINT "MenuBot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MenuSession" ADD CONSTRAINT "MenuSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MenuSession" ADD CONSTRAINT "MenuSession_botId_fkey" FOREIGN KEY ("botId") REFERENCES "MenuBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuSession" ADD CONSTRAINT "MenuSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MenuSession" ADD CONSTRAINT "MenuSession_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "ChannelConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuEvent" ADD CONSTRAINT "MenuEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MenuEvent" ADD CONSTRAINT "MenuEvent_botId_fkey" FOREIGN KEY ("botId") REFERENCES "MenuBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuEvent" ADD CONSTRAINT "MenuEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MenuSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database integrity (MULTI_PROJECT_PLAN.md §10.7).
CREATE CONSTRAINT TRIGGER "MenuSession_botId_same_project" AFTER INSERT OR UPDATE OF "botId", "projectId" ON "MenuSession" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('MenuBot', 'botId');
CREATE CONSTRAINT TRIGGER "MenuSession_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "MenuSession" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "MenuSession_channelConversationId_same_project" AFTER INSERT OR UPDATE OF "channelConversationId", "projectId" ON "MenuSession" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'channelConversationId');
CREATE CONSTRAINT TRIGGER "MenuEvent_botId_same_project" AFTER INSERT OR UPDATE OF "botId", "projectId" ON "MenuEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('MenuBot', 'botId');
CREATE CONSTRAINT TRIGGER "MenuEvent_sessionId_same_project" AFTER INSERT OR UPDATE OF "sessionId", "projectId" ON "MenuEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('MenuSession', 'sessionId');

CREATE TRIGGER "MenuBot_projectId_immutable" BEFORE UPDATE OF "projectId" ON "MenuBot" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "MenuSession_projectId_immutable" BEFORE UPDATE OF "projectId" ON "MenuSession" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "MenuEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "MenuEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

CREATE OR REPLACE FUNCTION menu_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Menu bot history rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MenuEvent_append_only" BEFORE UPDATE ON "MenuEvent" FOR EACH ROW EXECUTE FUNCTION menu_event_append_only();
