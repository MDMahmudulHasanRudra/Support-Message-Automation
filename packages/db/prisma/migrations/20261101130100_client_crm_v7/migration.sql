-- Client CRM & Billing V7 (CLIENT_CRM_V7.md). ADDITIVE ONLY: eight new project-owned tables and one enum. No existing
-- table, column, row or rule is changed; invoices, payments and their guards (CLIENTS_V3.md) are untouched.
--
-- Rollback before real use (nothing references these tables but each other):
--   DROP TABLE "ClientMessage", "ClientMessageBatch", "ClientMessageTemplateVersion", "ClientMessageTemplate",
--     "ClientRenewalOfferEvent", "ClientRenewalOffer", "ClientDocumentSettingsVersion", "ClientDocumentAsset" CASCADE;
--   DROP TYPE "ClientRenewalOfferStatus";
--   DROP FUNCTION client_crm_v7_append_only();
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261101130100_client_crm_v7';

-- CreateEnum
CREATE TYPE "ClientRenewalOfferStatus" AS ENUM ('PREPARED', 'CONTACTED', 'AWAITING_RESPONSE', 'ACCEPTED', 'DECLINED', 'RENEWED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "ClientRenewalOffer" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "status" "ClientRenewalOfferStatus" NOT NULL DEFAULT 'PREPARED',
    "service" TEXT NOT NULL,
    "durationValue" INTEGER NOT NULL,
    "durationUnit" "ClientDurationUnit" NOT NULL,
    "amount" DECIMAL(12,2),
    "currency" TEXT,
    "validUntil" DATE,
    "followUpDate" DATE,
    "note" TEXT,
    "responseNote" TEXT,
    "contactCount" INTEGER NOT NULL DEFAULT 0,
    "lastContactAt" TIMESTAMP(3),
    "soldByMemberId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "renewedSubscriptionId" TEXT,
    "invoiceDueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientRenewalOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientRenewalOfferEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "offerId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "channel" TEXT,
    "note" TEXT,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientRenewalOfferEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientMessageTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'ANY',
    "language" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdByName" TEXT,
    "updatedById" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientMessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientMessageTemplateVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "language" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientMessageTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientMessageBatch" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "templateId" TEXT,
    "templateVersion" INTEGER NOT NULL,
    "templateName" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "submittedById" TEXT,
    "submittedByName" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "recipientCount" INTEGER NOT NULL,
    "eligibleCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientMessageBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientMessage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "batchId" TEXT,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "channel" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL,
    "skipReason" TEXT,
    "toAddress" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "emailOutboxId" TEXT,
    "relatedDueId" TEXT,
    "relatedPaymentId" TEXT,
    "relatedOfferId" TEXT,
    "relatedSubscriptionId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientDocumentSettingsVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientDocumentSettingsVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientDocumentAsset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientDocumentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientRenewalOffer_renewedSubscriptionId_key" ON "ClientRenewalOffer"("renewedSubscriptionId");

-- CreateIndex
CREATE INDEX "ClientRenewalOffer_projectId_status_followUpDate_idx" ON "ClientRenewalOffer"("projectId", "status", "followUpDate");

-- CreateIndex
CREATE INDEX "ClientRenewalOffer_clientId_createdAt_idx" ON "ClientRenewalOffer"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientRenewalOffer_subscriptionId_idx" ON "ClientRenewalOffer"("subscriptionId");

-- CreateIndex
CREATE INDEX "ClientRenewalOfferEvent_offerId_createdAt_idx" ON "ClientRenewalOfferEvent"("offerId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientMessageTemplate_projectId_status_category_idx" ON "ClientMessageTemplate"("projectId", "status", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMessageTemplate_projectId_name_key" ON "ClientMessageTemplate"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMessageTemplateVersion_templateId_version_key" ON "ClientMessageTemplateVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "ClientMessageBatch_projectId_status_submittedAt_idx" ON "ClientMessageBatch"("projectId", "status", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMessage_emailOutboxId_key" ON "ClientMessage"("emailOutboxId");

-- CreateIndex
CREATE INDEX "ClientMessage_clientId_createdAt_idx" ON "ClientMessage"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientMessage_batchId_idx" ON "ClientMessage"("batchId");

-- CreateIndex
CREATE INDEX "ClientMessage_projectId_createdAt_idx" ON "ClientMessage"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientDocumentSettingsVersion_projectId_version_key" ON "ClientDocumentSettingsVersion"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ClientDocumentAsset_projectId_sha256_key" ON "ClientDocumentAsset"("projectId", "sha256");

-- AddForeignKey
ALTER TABLE "ClientRenewalOffer" ADD CONSTRAINT "ClientRenewalOffer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRenewalOffer" ADD CONSTRAINT "ClientRenewalOffer_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRenewalOffer" ADD CONSTRAINT "ClientRenewalOffer_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "ClientSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRenewalOffer" ADD CONSTRAINT "ClientRenewalOffer_soldByMemberId_fkey" FOREIGN KEY ("soldByMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRenewalOffer" ADD CONSTRAINT "ClientRenewalOffer_renewedSubscriptionId_fkey" FOREIGN KEY ("renewedSubscriptionId") REFERENCES "ClientSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRenewalOffer" ADD CONSTRAINT "ClientRenewalOffer_invoiceDueId_fkey" FOREIGN KEY ("invoiceDueId") REFERENCES "ClientDue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRenewalOfferEvent" ADD CONSTRAINT "ClientRenewalOfferEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRenewalOfferEvent" ADD CONSTRAINT "ClientRenewalOfferEvent_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "ClientRenewalOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRenewalOfferEvent" ADD CONSTRAINT "ClientRenewalOfferEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessageTemplate" ADD CONSTRAINT "ClientMessageTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessageTemplateVersion" ADD CONSTRAINT "ClientMessageTemplateVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessageTemplateVersion" ADD CONSTRAINT "ClientMessageTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClientMessageTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessageBatch" ADD CONSTRAINT "ClientMessageBatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessageBatch" ADD CONSTRAINT "ClientMessageBatch_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClientMessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ClientMessageBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClientMessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_emailOutboxId_fkey" FOREIGN KEY ("emailOutboxId") REFERENCES "EmailOutbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_relatedDueId_fkey" FOREIGN KEY ("relatedDueId") REFERENCES "ClientDue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_relatedPaymentId_fkey" FOREIGN KEY ("relatedPaymentId") REFERENCES "ClientPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_relatedOfferId_fkey" FOREIGN KEY ("relatedOfferId") REFERENCES "ClientRenewalOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientMessage" ADD CONSTRAINT "ClientMessage_relatedSubscriptionId_fkey" FOREIGN KEY ("relatedSubscriptionId") REFERENCES "ClientSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDocumentSettingsVersion" ADD CONSTRAINT "ClientDocumentSettingsVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDocumentAsset" ADD CONSTRAINT "ClientDocumentAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ── Rules every writer keeps (the app checks them too; these hold for raw SQL as well) ─────────────────────

-- One OPEN offer per term: two people preparing an offer for the same expiring term cannot both succeed.
CREATE UNIQUE INDEX "ClientRenewalOffer_one_open_per_term" ON "ClientRenewalOffer"("subscriptionId")
  WHERE "status" IN ('PREPARED', 'CONTACTED', 'AWAITING_RESPONSE', 'ACCEPTED');

ALTER TABLE "ClientRenewalOffer"
  -- A proposed price is an amount AND its currency, or neither.
  ADD CONSTRAINT "ClientRenewalOffer_price_check" CHECK (("amount" IS NULL) = ("currency" IS NULL) AND ("amount" IS NULL OR "amount" > 0)),
  ADD CONSTRAINT "ClientRenewalOffer_duration_check" CHECK ("durationValue" >= 1),
  ADD CONSTRAINT "ClientRenewalOffer_contacts_check" CHECK ("contactCount" >= 0);

ALTER TABLE "ClientMessageTemplate"
  ADD CONSTRAINT "ClientMessageTemplate_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  ADD CONSTRAINT "ClientMessageTemplate_version_check" CHECK ("version" >= 1);

ALTER TABLE "ClientMessageBatch"
  ADD CONSTRAINT "ClientMessageBatch_status_check" CHECK ("status" IN ('PENDING_APPROVAL', 'QUEUED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  -- Self-approval never exists (CLIENT_CENTER_PLAN.md decision 8): a queued batch was approved by someone else.
  ADD CONSTRAINT "ClientMessageBatch_no_self_approval" CHECK (
    "status" <> 'QUEUED' OR ("decidedById" IS NOT NULL AND "submittedById" IS NOT NULL AND "decidedById" <> "submittedById")
  ),
  ADD CONSTRAINT "ClientMessageBatch_counts_check" CHECK ("recipientCount" >= 0 AND "eligibleCount" >= 0 AND "skippedCount" >= 0 AND "eligibleCount" + "skippedCount" = "recipientCount");

ALTER TABLE "ClientMessage"
  ADD CONSTRAINT "ClientMessage_status_check" CHECK ("status" IN ('PREPARED', 'WAITING_APPROVAL', 'QUEUED', 'SKIPPED', 'CANCELLED')),
  ADD CONSTRAINT "ClientMessage_channel_check" CHECK ("channel" IN ('EMAIL', 'WHATSAPP', 'MESSENGER', 'INSTAGRAM', 'COPY')),
  -- Only an email is ever queued by Get Assist; every other channel is prepared for a person to send.
  ADD CONSTRAINT "ClientMessage_queued_is_email" CHECK ("status" <> 'QUEUED' OR ("channel" = 'EMAIL'));

ALTER TABLE "ClientDocumentSettingsVersion"
  ADD CONSTRAINT "ClientDocumentSettingsVersion_version_check" CHECK ("version" >= 1);

ALTER TABLE "ClientDocumentAsset"
  ADD CONSTRAINT "ClientDocumentAsset_type_check" CHECK ("mimeType" IN ('image/png', 'image/jpeg')),
  ADD CONSTRAINT "ClientDocumentAsset_size_check" CHECK ("byteLength" = octet_length("bytes") AND "byteLength" BETWEEN 1 AND 262144),
  ADD CONSTRAINT "ClientDocumentAsset_hash_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');

-- ── History is never rewritten ──────────────────────────────────────────────────────────────────────────────
-- UPDATE is refused; DELETE is not (a client's or a project's own deletion still removes its rows).
CREATE OR REPLACE FUNCTION client_crm_v7_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are history and are never changed', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "ClientRenewalOfferEvent_append_only" BEFORE UPDATE ON "ClientRenewalOfferEvent" FOR EACH ROW EXECUTE FUNCTION client_crm_v7_append_only();
CREATE TRIGGER "ClientMessageTemplateVersion_append_only" BEFORE UPDATE ON "ClientMessageTemplateVersion" FOR EACH ROW EXECUTE FUNCTION client_crm_v7_append_only();
CREATE TRIGGER "ClientDocumentSettingsVersion_append_only" BEFORE UPDATE ON "ClientDocumentSettingsVersion" FOR EACH ROW EXECUTE FUNCTION client_crm_v7_append_only();
CREATE TRIGGER "ClientDocumentAsset_append_only" BEFORE UPDATE ON "ClientDocumentAsset" FOR EACH ROW EXECUTE FUNCTION client_crm_v7_append_only();

-- ── Project integrity (MULTI_PROJECT_PLAN.md §10.7) ────────────────────────────────────────────────────────
CREATE TRIGGER "ClientRenewalOffer_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientRenewalOffer" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientRenewalOfferEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientRenewalOfferEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientMessageTemplate_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientMessageTemplate" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientMessageTemplateVersion_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientMessageTemplateVersion" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientMessageBatch_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientMessageBatch" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientMessage_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientMessage" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientDocumentSettingsVersion_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientDocumentSettingsVersion" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientDocumentAsset_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientDocumentAsset" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

CREATE CONSTRAINT TRIGGER "ClientRenewalOffer_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientRenewalOffer" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientRenewalOffer_subscriptionId_same_project" AFTER INSERT OR UPDATE OF "subscriptionId", "projectId" ON "ClientRenewalOffer" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientSubscription', 'subscriptionId');
CREATE CONSTRAINT TRIGGER "ClientRenewalOffer_soldByMemberId_same_project" AFTER INSERT OR UPDATE OF "soldByMemberId", "projectId" ON "ClientRenewalOffer" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'soldByMemberId');
CREATE CONSTRAINT TRIGGER "ClientRenewalOffer_renewedSubscriptionId_same_project" AFTER INSERT OR UPDATE OF "renewedSubscriptionId", "projectId" ON "ClientRenewalOffer" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientSubscription', 'renewedSubscriptionId');
CREATE CONSTRAINT TRIGGER "ClientRenewalOffer_invoiceDueId_same_project" AFTER INSERT OR UPDATE OF "invoiceDueId", "projectId" ON "ClientRenewalOffer" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientDue', 'invoiceDueId');
CREATE CONSTRAINT TRIGGER "ClientRenewalOfferEvent_offerId_same_project" AFTER INSERT OR UPDATE OF "offerId", "projectId" ON "ClientRenewalOfferEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientRenewalOffer', 'offerId');
CREATE CONSTRAINT TRIGGER "ClientRenewalOfferEvent_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientRenewalOfferEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientMessageTemplateVersion_templateId_same_project" AFTER INSERT OR UPDATE OF "templateId", "projectId" ON "ClientMessageTemplateVersion" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientMessageTemplate', 'templateId');
CREATE CONSTRAINT TRIGGER "ClientMessageBatch_templateId_same_project" AFTER INSERT OR UPDATE OF "templateId", "projectId" ON "ClientMessageBatch" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientMessageTemplate', 'templateId');
CREATE CONSTRAINT TRIGGER "ClientMessage_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientMessage_batchId_same_project" AFTER INSERT OR UPDATE OF "batchId", "projectId" ON "ClientMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientMessageBatch', 'batchId');
CREATE CONSTRAINT TRIGGER "ClientMessage_templateId_same_project" AFTER INSERT OR UPDATE OF "templateId", "projectId" ON "ClientMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientMessageTemplate', 'templateId');
CREATE CONSTRAINT TRIGGER "ClientMessage_emailOutboxId_same_project" AFTER INSERT OR UPDATE OF "emailOutboxId", "projectId" ON "ClientMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('EmailOutbox', 'emailOutboxId');
CREATE CONSTRAINT TRIGGER "ClientMessage_relatedDueId_same_project" AFTER INSERT OR UPDATE OF "relatedDueId", "projectId" ON "ClientMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientDue', 'relatedDueId');
CREATE CONSTRAINT TRIGGER "ClientMessage_relatedPaymentId_same_project" AFTER INSERT OR UPDATE OF "relatedPaymentId", "projectId" ON "ClientMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientPayment', 'relatedPaymentId');
CREATE CONSTRAINT TRIGGER "ClientMessage_relatedOfferId_same_project" AFTER INSERT OR UPDATE OF "relatedOfferId", "projectId" ON "ClientMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientRenewalOffer', 'relatedOfferId');
CREATE CONSTRAINT TRIGGER "ClientMessage_relatedSubscriptionId_same_project" AFTER INSERT OR UPDATE OF "relatedSubscriptionId", "projectId" ON "ClientMessage" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientSubscription', 'relatedSubscriptionId');

-- Two new permission keys. Nobody is granted anything: the Administrator module is re-synced to every key by the
-- seed. Neither ends in ".view", so Read Only does not receive them. Sending to a client and approving a bulk send
-- are separate keys so a project can have one person prepare and another approve (decision 8).
INSERT INTO "Permission" ("id", "key", "label", "category") VALUES
  (gen_random_uuid()::text, 'clients.send_messages', 'Send and Prepare Messages to Clients', 'Clients'),
  (gen_random_uuid()::text, 'clients.approve_messages', 'Approve Bulk Messages to Clients', 'Clients')
ON CONFLICT ("key") DO NOTHING;
