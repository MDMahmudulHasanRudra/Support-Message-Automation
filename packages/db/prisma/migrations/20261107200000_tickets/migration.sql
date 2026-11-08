-- Support tickets (TICKETS.md, feature TICKETS): a numbered case with an owner, a due time and a history, separate
-- from the conversation it may have come from. Additive only: one enum, three new tables. No existing row is touched.
-- Nothing here is read by any send path: a ticket never sends anything to a customer.

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "number" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "ConversationPriority" NOT NULL DEFAULT 'NORMAL',
    "category" TEXT,
    "assignedUserId" TEXT,
    "assignedTeamId" TEXT,
    "accountId" TEXT,
    "chatId" TEXT,
    "channelConversationId" TEXT,
    "clientId" TEXT,
    "dueAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id"),
    -- A WhatsApp chat is named by account and chat id. The chat id stays if the account is ever removed, so a ticket
    -- outlives the number it came in on.
    CONSTRAINT "Ticket_whatsapp_pair" CHECK ("accountId" IS NULL OR "chatId" IS NOT NULL),
    CONSTRAINT "Ticket_one_conversation" CHECK ("accountId" IS NULL OR "channelConversationId" IS NULL),
    CONSTRAINT "Ticket_paused_only_waiting" CHECK (("status" = 'WAITING_CUSTOMER') = ("pausedAt" IS NOT NULL)),
    CONSTRAINT "Ticket_resolved_time" CHECK (("status" IN ('RESOLVED', 'CLOSED')) = ("resolvedAt" IS NOT NULL)),
    CONSTRAINT "Ticket_closed_time" CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL)),
    CONSTRAINT "Ticket_subject_length" CHECK (char_length("subject") BETWEEN 1 AND 200),
    CONSTRAINT "Ticket_description_length" CHECK ("description" IS NULL OR char_length("description") <= 4000),
    CONSTRAINT "Ticket_number_positive" CHECK ("number" > 0)
);

-- CreateTable
CREATE TABLE "TicketEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "ticketId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "body" TEXT,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TicketEvent_kind_known" CHECK ("kind" IN ('CREATED', 'STATUS', 'ASSIGNED', 'TEAM', 'PRIORITY', 'CATEGORY', 'DUE', 'EDITED', 'NOTE')),
    CONSTRAINT "TicketEvent_note_has_body" CHECK (("kind" = 'NOTE') = ("body" IS NOT NULL)),
    CONSTRAINT "TicketEvent_body_length" CHECK ("body" IS NULL OR char_length("body") BETWEEN 1 AND 4000)
);

-- CreateTable
CREATE TABLE "TicketSettings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "urgentHours" INTEGER NOT NULL DEFAULT 4,
    "highHours" INTEGER NOT NULL DEFAULT 24,
    "normalHours" INTEGER NOT NULL DEFAULT 72,
    "lowHours" INTEGER NOT NULL DEFAULT 168,
    "categories" TEXT[] DEFAULT ARRAY['General', 'Billing', 'Technical']::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TicketSettings_targets" CHECK ("urgentHours" BETWEEN 1 AND 8760 AND "highHours" BETWEEN 1 AND 8760 AND "normalHours" BETWEEN 1 AND 8760 AND "lowHours" BETWEEN 1 AND 8760)
);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_projectId_number_key" ON "Ticket"("projectId", "number");
CREATE INDEX "Ticket_projectId_status_dueAt_idx" ON "Ticket"("projectId", "status", "dueAt");
CREATE INDEX "Ticket_projectId_assignedUserId_status_idx" ON "Ticket"("projectId", "assignedUserId", "status");
CREATE INDEX "Ticket_projectId_assignedTeamId_status_idx" ON "Ticket"("projectId", "assignedTeamId", "status");
CREATE INDEX "Ticket_projectId_accountId_chatId_idx" ON "Ticket"("projectId", "accountId", "chatId");
CREATE INDEX "Ticket_channelConversationId_idx" ON "Ticket"("channelConversationId");
CREATE INDEX "Ticket_clientId_idx" ON "Ticket"("clientId");
CREATE INDEX "TicketEvent_ticketId_createdAt_idx" ON "TicketEvent"("ticketId", "createdAt");
CREATE INDEX "TicketEvent_projectId_createdAt_idx" ON "TicketEvent"("projectId", "createdAt");
CREATE UNIQUE INDEX "TicketSettings_projectId_key" ON "TicketSettings"("projectId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assignedTeamId_fkey" FOREIGN KEY ("assignedTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "ChannelConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketSettings" ADD CONSTRAINT "TicketSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database integrity (MULTI_PROJECT_PLAN.md §10.7): every parent in the ticket's own project, and a fixed project.
CREATE CONSTRAINT TRIGGER "Ticket_assignedTeamId_same_project" AFTER INSERT OR UPDATE OF "assignedTeamId", "projectId" ON "Ticket" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Team', 'assignedTeamId');
CREATE CONSTRAINT TRIGGER "Ticket_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "Ticket" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "Ticket_channelConversationId_same_project" AFTER INSERT OR UPDATE OF "channelConversationId", "projectId" ON "Ticket" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'channelConversationId');
CREATE CONSTRAINT TRIGGER "Ticket_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "Ticket" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "TicketEvent_ticketId_same_project" AFTER INSERT OR UPDATE OF "ticketId", "projectId" ON "TicketEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Ticket', 'ticketId');
CREATE TRIGGER "Ticket_projectId_immutable" BEFORE UPDATE OF "projectId" ON "Ticket" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "TicketEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "TicketEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "TicketSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "TicketSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- The history is append-only. Deletion stays possible (a removed customer's data is emptied table by table); rewriting is not.
CREATE OR REPLACE FUNCTION ticket_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Ticket history rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "TicketEvent_append_only" BEFORE UPDATE ON "TicketEvent" FOR EACH ROW EXECUTE FUNCTION ticket_event_append_only();
