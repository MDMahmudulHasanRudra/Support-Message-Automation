-- Client <-> WhatsApp chat link (CLIENT_CENTER_PLAN.md §3.4, stage 4B).
--
-- Additive only: one new EMPTY project-scoped table and one permission row. No existing table, column,
-- index or row is touched, so it is safe on a live database. The feature it belongs to (CLIENT_CENTER)
-- ships OFF for every project. Nothing here sends a message.
--
-- A link is a person's statement that a one-to-one chat on an account IS a client. The database allows
-- ONE active link per (account, chat), so a chat can never belong to two clients at once.
--
-- Rollback (before any link exists): drop the table and delete the 'clients.link_whatsapp_chat'
-- Permission row, and the migration's _prisma_migrations row. After links exist, roll FORWARD.

-- CreateTable
CREATE TABLE "ClientWhatsAppChatLink" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "linkedById" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinkedById" TEXT,
    "unlinkedAt" TIMESTAMP(3),

    CONSTRAINT "ClientWhatsAppChatLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientWhatsAppChatLink_clientId_unlinkedAt_idx" ON "ClientWhatsAppChatLink"("clientId", "unlinkedAt");

-- CreateIndex
CREATE INDEX "ClientWhatsAppChatLink_projectId_accountId_chatId_idx" ON "ClientWhatsAppChatLink"("projectId", "accountId", "chatId");

-- One ACTIVE link per chat on an account (Prisma cannot model a partial unique index).
CREATE UNIQUE INDEX "ClientWhatsAppChatLink_active_chat_key" ON "ClientWhatsAppChatLink"("projectId", "accountId", "chatId") WHERE "unlinkedAt" IS NULL;

-- Only an individual chat can be linked (WhatsApp's own domains), never a group or a broadcast.
ALTER TABLE "ClientWhatsAppChatLink" ADD CONSTRAINT "ClientWhatsAppChatLink_chat_is_personal" CHECK ("chatId" ~ '.@(c\.us|lid)$');

-- AddForeignKey
ALTER TABLE "ClientWhatsAppChatLink" ADD CONSTRAINT "ClientWhatsAppChatLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientWhatsAppChatLink" ADD CONSTRAINT "ClientWhatsAppChatLink_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientWhatsAppChatLink" ADD CONSTRAINT "ClientWhatsAppChatLink_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientWhatsAppChatLink" ADD CONSTRAINT "ClientWhatsAppChatLink_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientWhatsAppChatLink" ADD CONSTRAINT "ClientWhatsAppChatLink_unlinkedById_fkey" FOREIGN KEY ("unlinkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 7 integrity (MULTI_PROJECT_PLAN.md §10.7).
CREATE TRIGGER "ClientWhatsAppChatLink_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientWhatsAppChatLink" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "ClientWhatsAppChatLink_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientWhatsAppChatLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientWhatsAppChatLink_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "ClientWhatsAppChatLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');

-- The permission key. Nobody is granted anything: the Administrator module is re-synced to every key by
-- the seed. It does not end in ".view", so Read Only does not receive it.
INSERT INTO "Permission" ("id", "key", "label", "category") VALUES
  (gen_random_uuid()::text, 'clients.link_whatsapp_chat', 'Link WhatsApp Chats to Clients', 'Clients')
ON CONFLICT ("key") DO NOTHING;
