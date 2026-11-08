-- Contacts (CONTACTS.md, feature CONTACTS): the people a business has met in its chats, kept apart from Clients and
-- Billing. Additive only: new enums, new tables, one new EmailPurpose value and six permission keys. No existing row is
-- changed. Nothing here is read by the message pipeline.

ALTER TYPE "EmailPurpose" ADD VALUE IF NOT EXISTS 'CONTACT_CAMPAIGN';

CREATE TYPE "ContactStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "ContactConsent" AS ENUM ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT');
CREATE TYPE "ContactSource" AS ENUM ('WHATSAPP', 'MESSENGER', 'INSTAGRAM', 'TELEGRAM', 'WEBSITE', 'MANUAL', 'IMPORT', 'CLIENT_LIST');
CREATE TYPE "ContactIdentifierKind" AS ENUM ('PHONE', 'EMAIL', 'FACEBOOK', 'INSTAGRAM', 'TELEGRAM', 'TIKTOK', 'LINKEDIN', 'X', 'YOUTUBE', 'WEBSITE', 'OTHER');
CREATE TYPE "ContactCampaignChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'MESSENGER', 'INSTAGRAM', 'TELEGRAM', 'SMS', 'CALL');
CREATE TYPE "ContactCampaignStatus" AS ENUM ('DRAFT', 'RUNNING', 'FINISHED');
CREATE TYPE "ContactRecipientStatus" AS ENUM ('PENDING', 'QUEUED', 'DONE', 'SKIPPED');

CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "serial" INTEGER NOT NULL,
    "code" TEXT,
    "name" TEXT,
    "company" TEXT,
    "jobTitle" TEXT,
    "address" TEXT,
    "city" TEXT,
    "country" TEXT,
    "mapUrl" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "birthday" TEXT,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "ContactSource" NOT NULL DEFAULT 'MANUAL',
    "sourceDetail" TEXT,
    "collectedByAi" BOOLEAN NOT NULL DEFAULT false,
    "status" "ContactStatus" NOT NULL DEFAULT 'ACTIVE',
    "consent" "ContactConsent" NOT NULL DEFAULT 'UNKNOWN',
    "linkedClientId" TEXT,
    "lastContactedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Contact_serial_positive" CHECK ("serial" > 0),
    CONSTRAINT "Contact_notes_length" CHECK ("notes" IS NULL OR char_length("notes") <= 10000),
    CONSTRAINT "Contact_map_https" CHECK ("mapUrl" IS NULL OR "mapUrl" ~* '^https?://'),
    CONSTRAINT "Contact_coordinates_pair" CHECK (("latitude" IS NULL) = ("longitude" IS NULL))
);

-- One row per value per project, whichever contact holds it: this index is what "never the same number twice" rests on.
CREATE TABLE "ContactIdentifier" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "contactId" TEXT NOT NULL,
    "kind" "ContactIdentifierKind" NOT NULL,
    "value" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "label" TEXT,
    "isWhatsApp" BOOLEAN NOT NULL DEFAULT false,
    "source" "ContactSource" NOT NULL DEFAULT 'MANUAL',
    "collectedByAi" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactIdentifier_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContactIdentifier_normalized_filled" CHECK (char_length("normalized") BETWEEN 1 AND 400)
);

-- One chat belongs to one contact; a contact can have many chats. A WhatsApp chat is named by its chat id, the same on
-- every one of our numbers, so two numbers in one group still mean one contact.
CREATE TABLE "ContactConversationLink" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "contactId" TEXT NOT NULL,
    "accountId" TEXT,
    "chatId" TEXT,
    "channelConversationId" TEXT,
    "source" "ContactSource" NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactConversationLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContactConversationLink_one_kind" CHECK (("chatId" IS NULL) <> ("channelConversationId" IS NULL))
);

CREATE TABLE "ContactEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "contactId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContactEvent_detail_length" CHECK ("detail" IS NULL OR char_length("detail") <= 1000)
);

CREATE TABLE "ContactSettings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "lastSerial" INTEGER NOT NULL DEFAULT 0,
    "aiCollectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoCreateFromChats" BOOLEAN NOT NULL DEFAULT false,
    "collectionStartedAt" TIMESTAMP(3),
    "whatsappCursorAt" TIMESTAMP(3),
    "whatsappCursorId" TEXT,
    "channelCursorAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactCampaign" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "name" TEXT NOT NULL,
    "channel" "ContactCampaignChannel" NOT NULL,
    "status" "ContactCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactCampaign_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContactCampaign_name_length" CHECK (char_length("name") BETWEEN 1 AND 120),
    CONSTRAINT "ContactCampaign_body_length" CHECK (char_length("body") BETWEEN 1 AND 4000),
    CONSTRAINT "ContactCampaign_email_subject" CHECK ("channel" <> 'EMAIL' OR "subject" IS NOT NULL)
);

CREATE TABLE "ContactCampaignRecipient" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "toValue" TEXT,
    "status" "ContactRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "emailOutboxId" TEXT,
    "doneById" TEXT,
    "doneByName" TEXT,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactCampaignRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Contact_projectId_serial_key" ON "Contact"("projectId", "serial");
CREATE UNIQUE INDEX "Contact_project_code_key" ON "Contact"("projectId", lower("code")) WHERE "code" IS NOT NULL;
CREATE INDEX "Contact_projectId_status_createdAt_idx" ON "Contact"("projectId", "status", "createdAt");
CREATE INDEX "Contact_projectId_source_idx" ON "Contact"("projectId", "source");
CREATE INDEX "Contact_linkedClientId_idx" ON "Contact"("linkedClientId");
CREATE UNIQUE INDEX "ContactIdentifier_projectId_kind_normalized_key" ON "ContactIdentifier"("projectId", "kind", "normalized");
CREATE INDEX "ContactIdentifier_contactId_idx" ON "ContactIdentifier"("contactId");
CREATE INDEX "ContactIdentifier_projectId_normalized_idx" ON "ContactIdentifier"("projectId", "normalized");
CREATE UNIQUE INDEX "ContactConversationLink_projectId_chatId_key" ON "ContactConversationLink"("projectId", "chatId");
CREATE UNIQUE INDEX "ContactConversationLink_projectId_channelConversationId_key" ON "ContactConversationLink"("projectId", "channelConversationId");
CREATE INDEX "ContactConversationLink_contactId_idx" ON "ContactConversationLink"("contactId");
CREATE INDEX "ContactEvent_contactId_createdAt_idx" ON "ContactEvent"("contactId", "createdAt");
CREATE UNIQUE INDEX "ContactSettings_projectId_key" ON "ContactSettings"("projectId");
CREATE INDEX "ContactCampaign_projectId_createdAt_idx" ON "ContactCampaign"("projectId", "createdAt");
CREATE UNIQUE INDEX "ContactCampaignRecipient_campaignId_contactId_key" ON "ContactCampaignRecipient"("campaignId", "contactId");
CREATE INDEX "ContactCampaignRecipient_campaignId_status_idx" ON "ContactCampaignRecipient"("campaignId", "status");
CREATE INDEX "ContactCampaignRecipient_contactId_idx" ON "ContactCampaignRecipient"("contactId");
CREATE UNIQUE INDEX "ContactCampaignRecipient_emailOutboxId_key" ON "ContactCampaignRecipient"("emailOutboxId");

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_linkedClientId_fkey" FOREIGN KEY ("linkedClientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactIdentifier" ADD CONSTRAINT "ContactIdentifier_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactIdentifier" ADD CONSTRAINT "ContactIdentifier_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactConversationLink" ADD CONSTRAINT "ContactConversationLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactConversationLink" ADD CONSTRAINT "ContactConversationLink_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactConversationLink" ADD CONSTRAINT "ContactConversationLink_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactConversationLink" ADD CONSTRAINT "ContactConversationLink_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "ChannelConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactEvent" ADD CONSTRAINT "ContactEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactEvent" ADD CONSTRAINT "ContactEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactSettings" ADD CONSTRAINT "ContactSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactCampaign" ADD CONSTRAINT "ContactCampaign_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactCampaign" ADD CONSTRAINT "ContactCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactCampaignRecipient" ADD CONSTRAINT "ContactCampaignRecipient_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactCampaignRecipient" ADD CONSTRAINT "ContactCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "ContactCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactCampaignRecipient" ADD CONSTRAINT "ContactCampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactCampaignRecipient" ADD CONSTRAINT "ContactCampaignRecipient_emailOutboxId_fkey" FOREIGN KEY ("emailOutboxId") REFERENCES "EmailOutbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Database integrity (MULTI_PROJECT_PLAN.md §10.7): every parent in the row's own project, and a fixed project.
CREATE CONSTRAINT TRIGGER "Contact_linkedClientId_same_project" AFTER INSERT OR UPDATE OF "linkedClientId", "projectId" ON "Contact" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'linkedClientId');
CREATE CONSTRAINT TRIGGER "ContactIdentifier_contactId_same_project" AFTER INSERT OR UPDATE OF "contactId", "projectId" ON "ContactIdentifier" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Contact', 'contactId');
CREATE CONSTRAINT TRIGGER "ContactConversationLink_contactId_same_project" AFTER INSERT OR UPDATE OF "contactId", "projectId" ON "ContactConversationLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Contact', 'contactId');
CREATE CONSTRAINT TRIGGER "ContactConversationLink_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "ContactConversationLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "ContactConversationLink_channelConversationId_same_project" AFTER INSERT OR UPDATE OF "channelConversationId", "projectId" ON "ContactConversationLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'channelConversationId');
CREATE CONSTRAINT TRIGGER "ContactEvent_contactId_same_project" AFTER INSERT OR UPDATE OF "contactId", "projectId" ON "ContactEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Contact', 'contactId');
CREATE CONSTRAINT TRIGGER "ContactCampaignRecipient_campaignId_same_project" AFTER INSERT OR UPDATE OF "campaignId", "projectId" ON "ContactCampaignRecipient" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ContactCampaign', 'campaignId');
CREATE CONSTRAINT TRIGGER "ContactCampaignRecipient_contactId_same_project" AFTER INSERT OR UPDATE OF "contactId", "projectId" ON "ContactCampaignRecipient" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Contact', 'contactId');
CREATE CONSTRAINT TRIGGER "ContactCampaignRecipient_emailOutboxId_same_project" AFTER INSERT OR UPDATE OF "emailOutboxId", "projectId" ON "ContactCampaignRecipient" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('EmailOutbox', 'emailOutboxId');

CREATE TRIGGER "Contact_projectId_immutable" BEFORE UPDATE OF "projectId" ON "Contact" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ContactIdentifier_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ContactIdentifier" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ContactConversationLink_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ContactConversationLink" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ContactEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ContactEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ContactSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ContactSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ContactCampaign_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ContactCampaign" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ContactCampaignRecipient_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ContactCampaignRecipient" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- The history is append-only. Deletion stays possible (a contact can be erased); rewriting is not.
CREATE OR REPLACE FUNCTION contact_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Contact history rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ContactEvent_append_only" BEFORE UPDATE ON "ContactEvent" FOR EACH ROW EXECUTE FUNCTION contact_event_append_only();

-- The keys are inserted here because the grant below needs them; the seed runs after migrations and adopts these rows.
INSERT INTO "Permission" ("id", "key", "label", "category") VALUES
  (gen_random_uuid()::text, 'contacts.view', 'View Contacts', 'Contacts'),
  (gen_random_uuid()::text, 'contacts.edit', 'Add and Edit Contacts', 'Contacts'),
  (gen_random_uuid()::text, 'contacts.delete', 'Permanently Delete Contacts', 'Contacts'),
  (gen_random_uuid()::text, 'contacts.import', 'Import Contacts', 'Contacts'),
  (gen_random_uuid()::text, 'contacts.export', 'Export Contacts', 'Contacts'),
  (gen_random_uuid()::text, 'contacts.campaign', 'Run Contact Campaigns', 'Contacts')
ON CONFLICT ("key") DO NOTHING;

-- Anyone who answers customers can use the Contact tab beside a chat from day one. Importing, exporting, deleting and
-- campaigns stay with whoever an administrator gives them to. System roles come from the seed.
INSERT INTO "PermissionModulePermission" ("permissionModuleId", "permissionId")
SELECT DISTINCT pmp."permissionModuleId", grant_key."id"
FROM "PermissionModulePermission" pmp
JOIN "Permission" reply ON reply."id" = pmp."permissionId" AND reply."key" IN ('messages.reply', 'conversations.reply')
JOIN "PermissionModule" pm ON pm."id" = pmp."permissionModuleId" AND pm."isSystem" = false
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "key" IN ('contacts.view', 'contacts.edit')) grant_key
ON CONFLICT DO NOTHING;
