-- Payment links (PAYMENT_LINKS.md, feature PAYMENT_LINKS, off by default): a link a business sends in a chat so a customer
-- can pay on SSLCOMMERZ or bKash, into the business's own merchant account. Additive only. Nothing moves money until a
-- business enters its own account details and a customer pays.

CREATE TYPE "PaymentProvider" AS ENUM ('SSLCOMMERZ', 'BKASH');
CREATE TYPE "PaymentMode" AS ENUM ('SANDBOX', 'LIVE');
CREATE TYPE "PaymentLinkStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED', 'EXPIRED');
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('STARTED', 'PAID', 'FAILED', 'UNKNOWN', 'MISMATCH');

CREATE TABLE "PaymentGateway" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "provider" "PaymentProvider" NOT NULL,
    "mode" "PaymentMode" NOT NULL DEFAULT 'SANDBOX',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "credentialsCiphertext" TEXT NOT NULL,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentGateway_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentSettings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentLink" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "number" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenCiphertext" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "description" TEXT,
    "status" "PaymentLinkStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paidProvider" "PaymentProvider",
    "gatewayTxnId" TEXT,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "attentionNote" TEXT,
    "receiptNumber" TEXT,
    "clientDueId" TEXT,
    "orderId" TEXT,
    "clientId" TEXT,
    "contactId" TEXT,
    "accountId" TEXT,
    "chatId" TEXT,
    "channelConversationId" TEXT,
    "customerName" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentLink_amount_positive" CHECK ("amountMinor" > 0),
    CONSTRAINT "PaymentLink_paid_time" CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL)),
    CONSTRAINT "PaymentLink_description_length" CHECK ("description" IS NULL OR char_length("description") <= 200)
);

CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "linkId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "reference" TEXT NOT NULL,
    "sessionRef" TEXT,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'STARTED',
    "gatewayTxnId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentLinkEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "linkId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLinkEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentGateway_projectId_provider_key" ON "PaymentGateway"("projectId", "provider");
CREATE UNIQUE INDEX "PaymentSettings_projectId_key" ON "PaymentSettings"("projectId");
CREATE UNIQUE INDEX "PaymentLink_projectId_number_key" ON "PaymentLink"("projectId", "number");
CREATE UNIQUE INDEX "PaymentLink_tokenHash_key" ON "PaymentLink"("tokenHash");
CREATE INDEX "PaymentLink_projectId_status_createdAt_idx" ON "PaymentLink"("projectId", "status", "createdAt");
CREATE INDEX "PaymentLink_projectId_chatId_idx" ON "PaymentLink"("projectId", "chatId");
CREATE INDEX "PaymentLink_channelConversationId_idx" ON "PaymentLink"("channelConversationId");
CREATE INDEX "PaymentLink_clientDueId_idx" ON "PaymentLink"("clientDueId");
-- A gateway reference names one try at paying: replays of a callback land on the same row.
CREATE UNIQUE INDEX "PaymentAttempt_projectId_provider_reference_key" ON "PaymentAttempt"("projectId", "provider", "reference");
CREATE INDEX "PaymentAttempt_linkId_idx" ON "PaymentAttempt"("linkId");
CREATE INDEX "PaymentAttempt_sessionRef_idx" ON "PaymentAttempt"("sessionRef");
CREATE INDEX "PaymentLinkEvent_linkId_createdAt_idx" ON "PaymentLinkEvent"("linkId", "createdAt");

ALTER TABLE "PaymentGateway" ADD CONSTRAINT "PaymentGateway_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentSettings" ADD CONSTRAINT "PaymentSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_clientDueId_fkey" FOREIGN KEY ("clientDueId") REFERENCES "ClientDue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "ChannelConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "PaymentLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentLinkEvent" ADD CONSTRAINT "PaymentLinkEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentLinkEvent" ADD CONSTRAINT "PaymentLinkEvent_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "PaymentLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE CONSTRAINT TRIGGER "PaymentLink_clientDueId_same_project" AFTER INSERT OR UPDATE OF "clientDueId", "projectId" ON "PaymentLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientDue', 'clientDueId');
CREATE CONSTRAINT TRIGGER "PaymentLink_orderId_same_project" AFTER INSERT OR UPDATE OF "orderId", "projectId" ON "PaymentLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('CommerceOrder', 'orderId');
CREATE CONSTRAINT TRIGGER "PaymentLink_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "PaymentLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "PaymentLink_contactId_same_project" AFTER INSERT OR UPDATE OF "contactId", "projectId" ON "PaymentLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Contact', 'contactId');
CREATE CONSTRAINT TRIGGER "PaymentLink_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "PaymentLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "PaymentLink_channelConversationId_same_project" AFTER INSERT OR UPDATE OF "channelConversationId", "projectId" ON "PaymentLink" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'channelConversationId');
CREATE CONSTRAINT TRIGGER "PaymentAttempt_linkId_same_project" AFTER INSERT OR UPDATE OF "linkId", "projectId" ON "PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('PaymentLink', 'linkId');
CREATE CONSTRAINT TRIGGER "PaymentLinkEvent_linkId_same_project" AFTER INSERT OR UPDATE OF "linkId", "projectId" ON "PaymentLinkEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('PaymentLink', 'linkId');

CREATE TRIGGER "PaymentGateway_projectId_immutable" BEFORE UPDATE OF "projectId" ON "PaymentGateway" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "PaymentSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "PaymentSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "PaymentLink_projectId_immutable" BEFORE UPDATE OF "projectId" ON "PaymentLink" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "PaymentAttempt_projectId_immutable" BEFORE UPDATE OF "projectId" ON "PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "PaymentLinkEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "PaymentLinkEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

CREATE OR REPLACE FUNCTION payment_link_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Payment history rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PaymentLinkEvent_append_only" BEFORE UPDATE ON "PaymentLinkEvent" FOR EACH ROW EXECUTE FUNCTION payment_link_event_append_only();

INSERT INTO "Permission" ("id", "key", "label", "category") VALUES
  (gen_random_uuid()::text, 'payments.view', 'View Payment Links', 'Payments'),
  (gen_random_uuid()::text, 'payments.create', 'Create Payment Links', 'Payments'),
  (gen_random_uuid()::text, 'payments.manage', 'Manage Payment Accounts', 'Payments')
ON CONFLICT ("key") DO NOTHING;
