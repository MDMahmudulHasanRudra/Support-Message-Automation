-- WhatsApp (Official API) (WHATSAPP_OFFICIAL.md, feature WHATSAPP_OFFICIAL, off by default): the Cloud API as one more channel. Additive only.
-- Nothing here touches WhatsApp (Legacy): its tables, loops and reports are not read or written.

ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'WHATSAPP_CLOUD';

ALTER TABLE "ChannelConnection" ADD COLUMN "wabaId" TEXT;
ALTER TABLE "ChannelMessage" ADD COLUMN "templateName" TEXT, ADD COLUMN "templateLanguage" TEXT, ADD COLUMN "templateParams" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "WhatsAppCloudTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "connectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "paramCount" INTEGER NOT NULL DEFAULT 0,
    "supported" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppCloudTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppCloudTemplate_connectionId_name_language_key" ON "WhatsAppCloudTemplate"("connectionId", "name", "language");
CREATE INDEX "WhatsAppCloudTemplate_projectId_idx" ON "WhatsAppCloudTemplate"("projectId");

ALTER TABLE "WhatsAppCloudTemplate" ADD CONSTRAINT "WhatsAppCloudTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppCloudTemplate" ADD CONSTRAINT "WhatsAppCloudTemplate_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE CONSTRAINT TRIGGER "WhatsAppCloudTemplate_connectionId_same_project" AFTER INSERT OR UPDATE OF "connectionId", "projectId" ON "WhatsAppCloudTemplate" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConnection', 'connectionId');
CREATE TRIGGER "WhatsAppCloudTemplate_projectId_immutable" BEFORE UPDATE OF "projectId" ON "WhatsAppCloudTemplate" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
