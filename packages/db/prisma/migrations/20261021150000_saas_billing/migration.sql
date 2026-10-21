-- SaaS platform, Phase 3 (SAAS_PLATFORM_PLAN.md section 10): plans, subscriptions, invoices,
-- payments, events and owner invitations. Purely additive: new tables, one nullable column, a
-- sequence, an index and a guard trigger. No existing row is changed. No customer is held: a
-- project is held only when an admin gives its customer a subscription that is suspended, and a new
-- subscription never suspends by itself unless an admin turns enforcement on (autoEnforce).
-- The removed Teams tables are deliberately NOT dropped here (see CLAUDE.md).

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "billingHoldAt" TIMESTAMP(3);
CREATE TABLE "PlatformBillingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "defaultGraceDays" INTEGER NOT NULL DEFAULT 7,
    "reminderDaysBefore" INTEGER[] DEFAULT ARRAY[7, 3, 1]::INTEGER[],
    "paymentInstructions" TEXT,
    "updatedByUsername" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformBillingSettings_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "interval" TEXT NOT NULL DEFAULT 'MONTH',
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "maxWhatsAppAccounts" INTEGER,
    "maxUsers" INTEGER,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "planId" TEXT,
    "planName" TEXT NOT NULL,
    "priceMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "interval" TEXT NOT NULL DEFAULT 'MONTH',
    "maxWhatsAppAccounts" INTEGER,
    "maxUsers" INTEGER,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3) NOT NULL,
    "trialEndsAt" TIMESTAMP(3),
    "paidThrough" TIMESTAMP(3),
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "autoEnforce" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" TIMESTAMP(3),
    "suspendReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "endedAt" TIMESTAMP(3),
    "createdByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "SubscriptionInvoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdByUsername" TEXT,
    CONSTRAINT "SubscriptionInvoice_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "recordedByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedByUsername" TEXT,
    "reversalReason" TEXT,
    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "SubscriptionEvent" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" JSONB,
    "dedupKey" TEXT,
    "actorUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "UserInvitation" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "linkCiphertext" TEXT,
    "createdByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserInvitation_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "Plan_name_key" ON "Plan"("name");
-- CreateIndex
CREATE INDEX "Subscription_customerId_idx" ON "Subscription"("customerId");
-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");
-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInvoice_number_key" ON "SubscriptionInvoice"("number");
-- CreateIndex
CREATE INDEX "SubscriptionInvoice_customerId_issuedAt_idx" ON "SubscriptionInvoice"("customerId", "issuedAt");
-- CreateIndex
CREATE INDEX "SubscriptionPayment_customerId_receivedAt_idx" ON "SubscriptionPayment"("customerId", "receivedAt");
-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionEvent_dedupKey_key" ON "SubscriptionEvent"("dedupKey");
-- CreateIndex
CREATE INDEX "SubscriptionEvent_customerId_createdAt_idx" ON "SubscriptionEvent"("customerId", "createdAt");
-- CreateIndex
CREATE UNIQUE INDEX "UserInvitation_tokenHash_key" ON "UserInvitation"("tokenHash");
-- CreateIndex
CREATE INDEX "UserInvitation_customerId_idx" ON "UserInvitation"("customerId");
-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubscriptionInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One CURRENT subscription per customer; replaced ones are kept with endedAt set.
CREATE UNIQUE INDEX "Subscription_one_current_per_customer" ON "Subscription"("customerId") WHERE "endedAt" IS NULL;

-- Invoice numbers come from a sequence, never from a count (two admins at once cannot collide).
CREATE SEQUENCE IF NOT EXISTS subscription_invoice_seq START 1;

-- A recorded payment is never rewritten or deleted: a mistake is reversed with a reason and the
-- right one recorded again. Only the reversal columns may change, once.
CREATE OR REPLACE FUNCTION subscription_payment_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A recorded subscription payment cannot be deleted; reverse it instead.';
  END IF;
  IF NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."method" IS DISTINCT FROM OLD."method"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
     OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
     OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId" THEN
    RAISE EXCEPTION 'A recorded subscription payment cannot be changed; reverse it instead.';
  END IF;
  IF OLD."reversedAt" IS NOT NULL AND (NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt" OR NEW."reversalReason" IS DISTINCT FROM OLD."reversalReason") THEN
    RAISE EXCEPTION 'A reversed subscription payment cannot be changed again.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SubscriptionPayment_immutable"
  BEFORE UPDATE OR DELETE ON "SubscriptionPayment"
  FOR EACH ROW EXECUTE FUNCTION subscription_payment_immutable();

-- An invitation is for one project for good (Phase 7: no row ever changes project).
CREATE TRIGGER "UserInvitation_projectId_immutable" BEFORE UPDATE OF "projectId" ON "UserInvitation" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
