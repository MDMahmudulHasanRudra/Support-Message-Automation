-- Client billing (CLIENT_CENTER_PLAN.md §2, stage 4A): manual due dates for a client, typed by staff.
--
-- Additive only: one new enum, three new EMPTY project-scoped tables and two permission rows. No
-- existing table, column, index or row is touched, so it is safe on a live database. The feature it
-- belongs to (CLIENT_CENTER) ships OFF for every project.
--
-- Deliberately absent: invoices, a ledger, payment confirmation, anything that sends. "Paid" is a
-- person's statement. The currency list ships EMPTY - no currency is assumed.
--
-- Rollback (before any due exists): drop the three tables, the type and the function, and delete the two
-- 'clients.*_billing' Permission rows. After dues exist, roll FORWARD instead.

-- CreateEnum
CREATE TYPE "ClientDueStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'WAIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ClientDue" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "amount" DECIMAL(12,2),
    "currency" TEXT,
    "status" "ClientDueStatus" NOT NULL DEFAULT 'UNPAID',
    "paidAmount" DECIMAL(12,2),
    "note" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientDue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientDueEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "dueId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientDueEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientBillingCurrency" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientBillingCurrency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientDue_clientId_dueDate_idx" ON "ClientDue"("clientId", "dueDate");

-- CreateIndex
CREATE INDEX "ClientDue_projectId_status_dueDate_idx" ON "ClientDue"("projectId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "ClientDueEvent_dueId_createdAt_idx" ON "ClientDueEvent"("dueId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientDueEvent_clientId_createdAt_idx" ON "ClientDueEvent"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientBillingCurrency_projectId_code_key" ON "ClientBillingCurrency"("projectId", "code");

-- AddForeignKey
ALTER TABLE "ClientDue" ADD CONSTRAINT "ClientDue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDue" ADD CONSTRAINT "ClientDue_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDue" ADD CONSTRAINT "ClientDue_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDue" ADD CONSTRAINT "ClientDue_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDueEvent" ADD CONSTRAINT "ClientDueEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDueEvent" ADD CONSTRAINT "ClientDueEvent_dueId_fkey" FOREIGN KEY ("dueId") REFERENCES "ClientDue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDueEvent" ADD CONSTRAINT "ClientDueEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDueEvent" ADD CONSTRAINT "ClientDueEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientBillingCurrency" ADD CONSTRAINT "ClientBillingCurrency_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientBillingCurrency" ADD CONSTRAINT "ClientBillingCurrency_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 7 integrity (MULTI_PROJECT_PLAN.md §10.7): no row changes project, and every project-owned
-- row it points at is in its own project.
CREATE TRIGGER "ClientDue_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientDue" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientDueEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientDueEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientBillingCurrency_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientBillingCurrency" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "ClientDue_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientDue" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientDueEvent_dueId_same_project" AFTER INSERT OR UPDATE OF "dueId", "projectId" ON "ClientDueEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientDue', 'dueId');
CREATE CONSTRAINT TRIGGER "ClientDueEvent_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientDueEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');

-- The due history is an audit: a row is written once and never changed. (Deleting a client or a due
-- removes its events by cascade; nothing else deletes them.)
CREATE FUNCTION client_due_event_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ClientDueEvent rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ClientDueEvent_no_update" BEFORE UPDATE ON "ClientDueEvent" FOR EACH ROW EXECUTE FUNCTION client_due_event_immutable();

-- Permission keys. Nobody is granted anything: the Administrator module is re-synced to every key by
-- the seed. "clients.view_billing" does not end in ".view", so the Read Only role does not get it.
INSERT INTO "Permission" ("id", "key", "label", "category") VALUES
  (gen_random_uuid()::text, 'clients.view_billing', 'View Client Billing', 'Clients'),
  (gen_random_uuid()::text, 'clients.edit_billing', 'Edit Client Billing', 'Clients')
ON CONFLICT ("key") DO NOTHING;
