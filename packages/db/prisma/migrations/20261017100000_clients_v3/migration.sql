-- Clients V3 (CLIENTS_V3.md): subscriptions, invoices with numbers, payments and allocations, client
-- photos, WhatsApp GROUP links, per-project module settings and per-person list columns.
--
-- Additive only, safe on a live database: new EMPTY tables, new NULLABLE columns on "Client" and
-- "ClientDue" (no backfill — older dues simply have no invoice number), two sequences, three permission
-- rows (granted to nobody). Nothing existing is rewritten, and the old code keeps working on the new
-- schema. The feature it belongs to (CLIENT_CENTER) ships OFF for every project. Nothing here sends.
--
-- The Teams tables Prisma would drop (removed integration, kept on purpose — CLAUDE.md) are NOT dropped.
--
-- Rollback (before real subscriptions/payments exist; after that, roll FORWARD):
--   BEGIN;
--   DELETE FROM "Permission" WHERE key IN ('clients.manage_subscriptions','clients.link_whatsapp_group','clients.manage_settings');
--   ALTER TABLE "Client" DROP COLUMN "currentSubscriptionId", DROP COLUMN "soldByMemberId", DROP COLUMN "country",
--     DROP COLUMN "preferredCurrency", DROP COLUMN "photoUpdatedAt";
--   ALTER TABLE "ClientDue" DROP COLUMN "invoiceNumber", DROP COLUMN "kind", DROP COLUMN "issuedDate", DROP COLUMN "service",
--     DROP COLUMN "subscriptionId", DROP COLUMN "soldByMemberId";
--   DROP TABLE "ClientPaymentAllocation", "ClientPayment", "ClientWhatsAppGroupLink", "ClientPhoto", "ClientSubscription",
--     "ClientModuleSettings", "ListViewPreference";
--   DROP FUNCTION client_payment_guard(), client_payment_allocation_immutable(), client_payment_allocation_matches();
--   DROP TYPE "ClientSubscriptionKind", "ClientDurationUnit", "ClientDueKind", "ClientPaymentMethod";
--   DROP SEQUENCE "client_invoice_seq", "client_receipt_seq";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261017100000_clients_v3';
--   COMMIT;

-- CreateEnum
CREATE TYPE "ClientSubscriptionKind" AS ENUM ('PAID', 'TRIAL', 'DEMO', 'COMPLIMENTARY');


-- CreateEnum
CREATE TYPE "ClientDurationUnit" AS ENUM ('DAY', 'WEEK', 'MONTH', 'YEAR');


-- CreateEnum
CREATE TYPE "ClientDueKind" AS ENUM ('SUBSCRIPTION', 'RENEWAL', 'SERVICE', 'ONE_OFF', 'OTHER');


-- CreateEnum
CREATE TYPE "ClientPaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'MOBILE_BANKING', 'CARD', 'CHEQUE', 'ONLINE', 'OTHER');


-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "country" TEXT,
ADD COLUMN     "currentSubscriptionId" TEXT,
ADD COLUMN     "photoUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "preferredCurrency" TEXT,
ADD COLUMN     "soldByMemberId" TEXT;


-- AlterTable
ALTER TABLE "ClientDue" ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "issuedDate" DATE,
ADD COLUMN     "kind" "ClientDueKind",
ADD COLUMN     "service" TEXT,
ADD COLUMN     "soldByMemberId" TEXT,
ADD COLUMN     "subscriptionId" TEXT;


-- CreateTable
CREATE TABLE "ClientSubscription" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "kind" "ClientSubscriptionKind" NOT NULL DEFAULT 'PAID',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "durationValue" INTEGER,
    "durationUnit" "ClientDurationUnit",
    "isRenewal" BOOLEAN NOT NULL DEFAULT false,
    "renewedFromId" TEXT,
    "soldByMemberId" TEXT,
    "soldByTeamId" TEXT,
    "soldByName" TEXT,
    "soldByTeamName" TEXT,
    "note" TEXT,
    "pausedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientSubscription_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "ClientPhoto" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientPhoto_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "ClientPayment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "receiptNumber" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "ClientPaymentMethod" NOT NULL,
    "reference" TEXT,
    "receivedDate" DATE NOT NULL,
    "note" TEXT,
    "batchReference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "ClientPayment_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "ClientPaymentAllocation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "paymentId" TEXT NOT NULL,
    "dueId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientPaymentAllocation_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "ClientWhatsAppGroupLink" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "accountId" TEXT,
    "groupId" TEXT,
    "whatsappGroupId" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "linkedById" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinkedById" TEXT,
    "unlinkedAt" TIMESTAMP(3),
    "unlinkReason" TEXT,

    CONSTRAINT "ClientWhatsAppGroupLink_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "ClientModuleSettings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "subscriptionsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "billingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "paymentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsappGroupLinksEnabled" BOOLEAN NOT NULL DEFAULT true,
    "requiredFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "renewalWindowDays" INTEGER NOT NULL DEFAULT 7,
    "defaultCountry" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientModuleSettings_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "ListViewPreference" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "userId" TEXT NOT NULL,
    "listKey" TEXT NOT NULL,
    "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListViewPreference_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "ClientSubscription_clientId_endDate_idx" ON "ClientSubscription"("clientId", "endDate");


-- CreateIndex
CREATE INDEX "ClientSubscription_projectId_endDate_idx" ON "ClientSubscription"("projectId", "endDate");


-- CreateIndex
CREATE INDEX "ClientSubscription_soldByMemberId_idx" ON "ClientSubscription"("soldByMemberId");


-- CreateIndex
CREATE UNIQUE INDEX "ClientPhoto_clientId_key" ON "ClientPhoto"("clientId");


-- CreateIndex
CREATE INDEX "ClientPayment_clientId_receivedDate_idx" ON "ClientPayment"("clientId", "receivedDate");


-- CreateIndex
CREATE INDEX "ClientPayment_projectId_receivedDate_idx" ON "ClientPayment"("projectId", "receivedDate");


-- CreateIndex
CREATE UNIQUE INDEX "ClientPayment_projectId_receiptNumber_key" ON "ClientPayment"("projectId", "receiptNumber");


-- CreateIndex
CREATE UNIQUE INDEX "ClientPayment_projectId_idempotencyKey_key" ON "ClientPayment"("projectId", "idempotencyKey");


-- CreateIndex
CREATE INDEX "ClientPaymentAllocation_dueId_idx" ON "ClientPaymentAllocation"("dueId");


-- CreateIndex
CREATE UNIQUE INDEX "ClientPaymentAllocation_paymentId_dueId_key" ON "ClientPaymentAllocation"("paymentId", "dueId");


-- CreateIndex
CREATE INDEX "ClientWhatsAppGroupLink_clientId_unlinkedAt_idx" ON "ClientWhatsAppGroupLink"("clientId", "unlinkedAt");


-- CreateIndex
CREATE INDEX "ClientWhatsAppGroupLink_projectId_whatsappGroupId_idx" ON "ClientWhatsAppGroupLink"("projectId", "whatsappGroupId");


-- CreateIndex
CREATE INDEX "ClientWhatsAppGroupLink_groupId_idx" ON "ClientWhatsAppGroupLink"("groupId");


-- CreateIndex
CREATE UNIQUE INDEX "ClientModuleSettings_projectId_key" ON "ClientModuleSettings"("projectId");


-- CreateIndex
CREATE UNIQUE INDEX "ListViewPreference_projectId_userId_listKey_key" ON "ListViewPreference"("projectId", "userId", "listKey");


-- CreateIndex
CREATE INDEX "Client_projectId_country_idx" ON "Client"("projectId", "country");


-- CreateIndex
CREATE INDEX "Client_currentSubscriptionId_idx" ON "Client"("currentSubscriptionId");


-- CreateIndex
CREATE INDEX "ClientDue_subscriptionId_idx" ON "ClientDue"("subscriptionId");


-- CreateIndex
CREATE UNIQUE INDEX "ClientDue_projectId_invoiceNumber_key" ON "ClientDue"("projectId", "invoiceNumber");


-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_soldByMemberId_fkey" FOREIGN KEY ("soldByMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_currentSubscriptionId_fkey" FOREIGN KEY ("currentSubscriptionId") REFERENCES "ClientSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientDue" ADD CONSTRAINT "ClientDue_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "ClientSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientDue" ADD CONSTRAINT "ClientDue_soldByMemberId_fkey" FOREIGN KEY ("soldByMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientSubscription" ADD CONSTRAINT "ClientSubscription_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientSubscription" ADD CONSTRAINT "ClientSubscription_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientSubscription" ADD CONSTRAINT "ClientSubscription_renewedFromId_fkey" FOREIGN KEY ("renewedFromId") REFERENCES "ClientSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientSubscription" ADD CONSTRAINT "ClientSubscription_soldByMemberId_fkey" FOREIGN KEY ("soldByMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientSubscription" ADD CONSTRAINT "ClientSubscription_soldByTeamId_fkey" FOREIGN KEY ("soldByTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientSubscription" ADD CONSTRAINT "ClientSubscription_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientPhoto" ADD CONSTRAINT "ClientPhoto_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientPhoto" ADD CONSTRAINT "ClientPhoto_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientPhoto" ADD CONSTRAINT "ClientPhoto_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientPaymentAllocation" ADD CONSTRAINT "ClientPaymentAllocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientPaymentAllocation" ADD CONSTRAINT "ClientPaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ClientPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientPaymentAllocation" ADD CONSTRAINT "ClientPaymentAllocation_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "ClientDue"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientWhatsAppGroupLink" ADD CONSTRAINT "ClientWhatsAppGroupLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientWhatsAppGroupLink" ADD CONSTRAINT "ClientWhatsAppGroupLink_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientWhatsAppGroupLink" ADD CONSTRAINT "ClientWhatsAppGroupLink_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientWhatsAppGroupLink" ADD CONSTRAINT "ClientWhatsAppGroupLink_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientWhatsAppGroupLink" ADD CONSTRAINT "ClientWhatsAppGroupLink_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientWhatsAppGroupLink" ADD CONSTRAINT "ClientWhatsAppGroupLink_unlinkedById_fkey" FOREIGN KEY ("unlinkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientModuleSettings" ADD CONSTRAINT "ClientModuleSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ClientModuleSettings" ADD CONSTRAINT "ClientModuleSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ListViewPreference" ADD CONSTRAINT "ListViewPreference_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ListViewPreference" ADD CONSTRAINT "ListViewPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Integrity the Prisma schema cannot express ───────────────────────────────────────────────────

-- One ACTIVE owner per WhatsApp group in a project (keyed on the WhatsApp id, not our row: two of our
-- numbers in one group are two rows for one group). An unlinked row frees the group.
CREATE UNIQUE INDEX "ClientWhatsAppGroupLink_active_group_key" ON "ClientWhatsAppGroupLink"("projectId", "whatsappGroupId") WHERE "unlinkedAt" IS NULL;
-- A group, never a one-to-one chat (those are ClientWhatsAppChatLink's, which refuses a group the same way).
ALTER TABLE "ClientWhatsAppGroupLink" ADD CONSTRAINT "ClientWhatsAppGroupLink_is_group" CHECK ("whatsappGroupId" ~ '^[0-9][0-9-]*@g\.us$');

-- A photo is a bounded thumbnail, never an unbounded blob.
ALTER TABLE "ClientPhoto" ADD CONSTRAINT "ClientPhoto_bounded" CHECK (octet_length("bytes") BETWEEN 1 AND 204800 AND "width" BETWEEN 16 AND 1024 AND "height" BETWEEN 16 AND 1024 AND "mimeType" IN ('image/jpeg', 'image/png', 'image/webp'));

ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "ClientPaymentAllocation" ADD CONSTRAINT "ClientPaymentAllocation_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "ClientSubscription" ADD CONSTRAINT "ClientSubscription_dates" CHECK ("endDate" > "startDate");
ALTER TABLE "ClientModuleSettings" ADD CONSTRAINT "ClientModuleSettings_renewal_window" CHECK ("renewalWindowDays" BETWEEN 0 AND 90);

-- A payment is money that arrived: its client, currency, amount and number never change, and a reversal
-- is final. Only the reversal columns may be set, once.
CREATE FUNCTION client_payment_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."amount" IS DISTINCT FROM OLD."amount" OR NEW."receiptNumber" IS DISTINCT FROM OLD."receiptNumber"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."receivedDate" IS DISTINCT FROM OLD."receivedDate"
     OR NEW."method" IS DISTINCT FROM OLD."method" OR NEW."recordedAt" IS DISTINCT FROM OLD."recordedAt" THEN
    RAISE EXCEPTION 'A recorded payment cannot be changed; reverse it and record a new one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."reversedAt" IS NOT NULL AND NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt" THEN
    RAISE EXCEPTION 'A reversed payment stays reversed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ClientPayment_guard" BEFORE UPDATE ON "ClientPayment" FOR EACH ROW EXECUTE FUNCTION client_payment_guard();

-- An allocation is the record of what a payment settled: never rewritten.
CREATE FUNCTION client_payment_allocation_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A payment allocation cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ClientPaymentAllocation_no_update" BEFORE UPDATE ON "ClientPaymentAllocation" FOR EACH ROW EXECUTE FUNCTION client_payment_allocation_immutable();

-- An allocation may only settle a due of the payment's own client and currency (defence in depth; the
-- application plans it the same way under row locks).
CREATE FUNCTION client_payment_allocation_matches() RETURNS trigger AS $$
DECLARE
  pay_client text; pay_currency text; due_client text; due_currency text;
BEGIN
  SELECT "clientId", "currency" INTO pay_client, pay_currency FROM "ClientPayment" WHERE "id" = NEW."paymentId";
  SELECT "clientId", "currency" INTO due_client, due_currency FROM "ClientDue" WHERE "id" = NEW."dueId";
  IF pay_client IS DISTINCT FROM due_client OR pay_currency IS DISTINCT FROM due_currency THEN
    RAISE EXCEPTION 'A payment can only settle a due of the same client and currency' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ClientPaymentAllocation_matches_due" AFTER INSERT ON "ClientPaymentAllocation" FOR EACH ROW EXECUTE FUNCTION client_payment_allocation_matches();

-- Invoice and receipt numbers ("INV-000042", "RCPT-000042"), like client_code_seq.
CREATE SEQUENCE IF NOT EXISTS "client_invoice_seq" START 1;
CREATE SEQUENCE IF NOT EXISTS "client_receipt_seq" START 1;

-- Phase 7 integrity (MULTI_PROJECT_PLAN.md §10.7): projectId never moves, and no row points into another project.
CREATE TRIGGER "ClientSubscription_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientSubscription" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientPhoto_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientPhoto" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientPayment_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientPayment" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientPaymentAllocation_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientPaymentAllocation" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientWhatsAppGroupLink_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientWhatsAppGroupLink" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientModuleSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientModuleSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ListViewPreference_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ListViewPreference" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

CREATE CONSTRAINT TRIGGER "Client_soldByMemberId_same_project" AFTER INSERT OR UPDATE OF "soldByMemberId", "projectId" ON "Client" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'soldByMemberId');
CREATE CONSTRAINT TRIGGER "Client_currentSubscriptionId_same_project" AFTER INSERT OR UPDATE OF "currentSubscriptionId", "projectId" ON "Client" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientSubscription', 'currentSubscriptionId');
CREATE CONSTRAINT TRIGGER "ClientDue_subscriptionId_same_project" AFTER INSERT OR UPDATE OF "subscriptionId", "projectId" ON "ClientDue" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientSubscription', 'subscriptionId');
CREATE CONSTRAINT TRIGGER "ClientDue_soldByMemberId_same_project" AFTER INSERT OR UPDATE OF "soldByMemberId", "projectId" ON "ClientDue" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'soldByMemberId');
CREATE CONSTRAINT TRIGGER "ClientSubscription_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientSubscription" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientSubscription_renewedFromId_same_project" AFTER INSERT OR UPDATE OF "renewedFromId", "projectId" ON "ClientSubscription" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientSubscription', 'renewedFromId');
CREATE CONSTRAINT TRIGGER "ClientSubscription_soldByMemberId_same_project" AFTER INSERT OR UPDATE OF "soldByMemberId", "projectId" ON "ClientSubscription" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'soldByMemberId');
CREATE CONSTRAINT TRIGGER "ClientSubscription_soldByTeamId_same_project" AFTER INSERT OR UPDATE OF "soldByTeamId", "projectId" ON "ClientSubscription" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Team', 'soldByTeamId');
CREATE CONSTRAINT TRIGGER "ClientPhoto_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientPhoto" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientPayment_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientPayment" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientPaymentAllocation_paymentId_same_project" AFTER INSERT OR UPDATE OF "paymentId", "projectId" ON "ClientPaymentAllocation" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientPayment', 'paymentId');
CREATE CONSTRAINT TRIGGER "ClientPaymentAllocation_dueId_same_project" AFTER INSERT OR UPDATE OF "dueId", "projectId" ON "ClientPaymentAllocation" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientDue', 'dueId');
CREATE CONSTRAINT TRIGGER "ClientWhatsAppGroupLink_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientWhatsAppGroupLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientWhatsAppGroupLink_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "ClientWhatsAppGroupLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "ClientWhatsAppGroupLink_groupId_same_project" AFTER INSERT OR UPDATE OF "groupId", "projectId" ON "ClientWhatsAppGroupLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppGroup', 'groupId');

-- The three new permission keys. Nobody is granted anything: the Administrator module is re-synced to
-- every key by the seed. None ends in ".view", so Read Only does not receive them.
INSERT INTO "Permission" ("id", "key", "label", "category") VALUES
  (gen_random_uuid()::text, 'clients.manage_subscriptions', 'Sell, Renew and Cancel Client Subscriptions', 'Clients'),
  (gen_random_uuid()::text, 'clients.link_whatsapp_group', 'Link WhatsApp Groups to Clients', 'Clients'),
  (gen_random_uuid()::text, 'clients.manage_settings', 'Manage Client Module Settings', 'Clients')
ON CONFLICT ("key") DO NOTHING;
