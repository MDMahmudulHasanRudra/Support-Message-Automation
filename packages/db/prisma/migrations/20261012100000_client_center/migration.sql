-- Client Management (CLIENT_CENTER.md): one client database, whatever channel a client uses.
--
-- Additive only: six new enums, five new EMPTY project-scoped tables, one sequence and seven
-- permission rows. No existing table, column, index or row is touched, so it is safe on a live
-- database (creating empty tables takes no lock on anything existing). The feature ships OFF for
-- every project (ProjectFeature CLIENT_CENTER, default disabled); until a Main Admin enables it
-- nothing reads or writes these tables.
--
-- Deliberately absent: invoices, payments, balances (the company's billing lives in its own system)
-- and anything that sends a message.
--
-- Rollback (before any client exists): drop the five tables, the six types, the sequence, and delete
-- the seven 'clients.*' Permission rows. After clients exist, roll FORWARD instead.

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING', 'ARCHIVED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ClientSource" AS ENUM ('MANUAL', 'IMPORT', 'WHATSAPP', 'FACEBOOK', 'INSTAGRAM', 'API');

-- CreateEnum
CREATE TYPE "ClientChannelKind" AS ENUM ('PHONE', 'EMAIL', 'WHATSAPP', 'WHATSAPP_GROUP', 'MESSENGER', 'INSTAGRAM', 'TELEGRAM', 'OTHER');

-- CreateEnum
CREATE TYPE "ClientConsentStatus" AS ENUM ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "ClientImportStatus" AS ENUM ('PREVIEW', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClientDuplicatePolicy" AS ENUM ('SKIP', 'UPDATE', 'CREATE');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyName" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "category" TEXT,
    "preferredChannel" "ClientChannelKind",
    "preferredLanguage" TEXT,
    "address" TEXT,
    "businessDetails" TEXT,
    "followUpInstructions" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "source" "ClientSource" NOT NULL DEFAULT 'MANUAL',
    "sourceDetail" TEXT,
    "assignedMemberId" TEXT,
    "assignedTeamId" TEXT,
    "createdById" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientChannel" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "kind" "ClientChannelKind" NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "consentStatus" "ClientConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "consentChangedAt" TIMESTAMP(3),
    "consentSource" TEXT,
    "consentNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientNote" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientActivity" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientImportJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "createdById" TEXT,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "status" "ClientImportStatus" NOT NULL DEFAULT 'PREVIEW',
    "duplicatePolicy" "ClientDuplicatePolicy" NOT NULL DEFAULT 'SKIP',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "rows" JSONB NOT NULL DEFAULT '[]',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ClientImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Client_projectId_status_name_idx" ON "Client"("projectId", "status", "name");

-- CreateIndex
CREATE INDEX "Client_projectId_assignedMemberId_idx" ON "Client"("projectId", "assignedMemberId");

-- CreateIndex
CREATE INDEX "Client_projectId_createdAt_idx" ON "Client"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Client_tags_idx" ON "Client" USING GIN ("tags");

-- CreateIndex
CREATE UNIQUE INDEX "Client_projectId_code_key" ON "Client"("projectId", "code");

-- CreateIndex
CREATE INDEX "ClientChannel_projectId_kind_normalizedValue_idx" ON "ClientChannel"("projectId", "kind", "normalizedValue");

-- CreateIndex
CREATE UNIQUE INDEX "ClientChannel_clientId_kind_normalizedValue_key" ON "ClientChannel"("clientId", "kind", "normalizedValue");

-- CreateIndex
CREATE INDEX "ClientNote_clientId_createdAt_idx" ON "ClientNote"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientActivity_clientId_createdAt_idx" ON "ClientActivity"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientActivity_projectId_createdAt_idx" ON "ClientActivity"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientImportJob_projectId_createdAt_idx" ON "ClientImportJob"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_assignedMemberId_fkey" FOREIGN KEY ("assignedMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_assignedTeamId_fkey" FOREIGN KEY ("assignedTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientChannel" ADD CONSTRAINT "ClientChannel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientChannel" ADD CONSTRAINT "ClientChannel_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientNote" ADD CONSTRAINT "ClientNote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientNote" ADD CONSTRAINT "ClientNote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientNote" ADD CONSTRAINT "ClientNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientActivity" ADD CONSTRAINT "ClientActivity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientActivity" ADD CONSTRAINT "ClientActivity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientActivity" ADD CONSTRAINT "ClientActivity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientImportJob" ADD CONSTRAINT "ClientImportJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientImportJob" ADD CONSTRAINT "ClientImportJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Client codes ("CL-000042") when none is typed. One sequence for the installation, so a code is
-- unique inside any project without a per-project counter row to lock.
CREATE SEQUENCE "client_code_seq" START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Phase 7 integrity (MULTI_PROJECT_PLAN.md §10.7): no row changes project, and every project-owned
-- row it points at is in its own project. User columns point at platform users, which have no project.
CREATE TRIGGER "Client_projectId_immutable" BEFORE UPDATE OF "projectId" ON "Client" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientChannel_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientChannel" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientNote_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientNote" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientActivity_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientActivity" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientImportJob_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientImportJob" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "Client_assignedMemberId_same_project" AFTER INSERT OR UPDATE OF "assignedMemberId", "projectId" ON "Client" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'assignedMemberId');
CREATE CONSTRAINT TRIGGER "Client_assignedTeamId_same_project" AFTER INSERT OR UPDATE OF "assignedTeamId", "projectId" ON "Client" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Team', 'assignedTeamId');
CREATE CONSTRAINT TRIGGER "ClientChannel_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientChannel" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientNote_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientNote" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
CREATE CONSTRAINT TRIGGER "ClientActivity_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientActivity" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');

-- The permission keys. Inserted here as well as by the seed (which upserts by key and simply adopts
-- them) so a role editor opened before the next seed already offers them. Nobody is granted anything:
-- the Administrator role is re-synced to every key by the seed, and a custom role gets none.
INSERT INTO "Permission" ("id", "key", "label", "category") VALUES
  (gen_random_uuid()::text, 'clients.view', 'View Clients', 'Clients'),
  (gen_random_uuid()::text, 'clients.create', 'Create Clients', 'Clients'),
  (gen_random_uuid()::text, 'clients.update', 'Edit Clients', 'Clients'),
  (gen_random_uuid()::text, 'clients.archive', 'Archive & Restore Clients', 'Clients'),
  (gen_random_uuid()::text, 'clients.delete', 'Permanently Delete Clients', 'Clients'),
  (gen_random_uuid()::text, 'clients.import', 'Import Clients', 'Clients'),
  (gen_random_uuid()::text, 'clients.export', 'Export Clients', 'Clients')
ON CONFLICT ("key") DO NOTHING;
