-- Smart Bulk Import (SMART_IMPORT.md). Additive: two enum values, new ClientImportJob columns with
-- defaults that leave every existing job exactly as it was (engine 'LEGACY'), and two new tables.
-- Nothing reads any of it unless a project's CLIENT_SMART_IMPORT feature is on.
-- Rollback: switch the feature off. (The tables can be dropped; the columns and enum values are inert.)

-- AlterEnum


ALTER TYPE "ClientImportStatus" ADD VALUE 'QUEUED';
ALTER TYPE "ClientImportStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "ClientImportJob" ADD COLUMN     "acknowledgedWarnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "allowSubscriptions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "blankHeaders" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedRevision" INTEGER,
ADD COLUMN     "duplicateHeaders" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "engine" TEXT NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "fileSize" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "headerRow" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "headers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "queuedAt" TIMESTAMP(3),
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sheetName" TEXT,
ADD COLUMN     "sheetNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stagingKey" TEXT;

-- CreateTable
CREATE TABLE "ClientImportRow" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "jobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "source" JSONB NOT NULL,
    "edits" JSONB NOT NULL DEFAULT '{}',
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT,
    "message" TEXT,
    "clientId" TEXT,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ClientImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientImportPreset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "name" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "mapping" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientImportPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientImportRow_jobId_outcome_idx" ON "ClientImportRow"("jobId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "ClientImportRow_jobId_rowNumber_key" ON "ClientImportRow"("jobId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ClientImportPreset_projectId_name_key" ON "ClientImportPreset"("projectId", "name");

-- CreateIndex
CREATE INDEX "ClientImportJob_engine_status_leaseUntil_idx" ON "ClientImportJob"("engine", "status", "leaseUntil");

-- AddForeignKey
ALTER TABLE "ClientImportRow" ADD CONSTRAINT "ClientImportRow_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientImportRow" ADD CONSTRAINT "ClientImportRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ClientImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientImportRow" ADD CONSTRAINT "ClientImportRow_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientImportPreset" ADD CONSTRAINT "ClientImportPreset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientImportPreset" ADD CONSTRAINT "ClientImportPreset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- An outcome is one of a fixed set, and a processed row says when.
ALTER TABLE "ClientImportRow" ADD CONSTRAINT "ClientImportRow_outcome_valid" CHECK (
  "outcome" IS NULL OR "outcome" IN ('PENDING', 'CREATED', 'UPDATED', 'SKIPPED', 'INVALID', 'FAILED', 'IGNORED')
);
ALTER TABLE "ClientImportJob" ADD CONSTRAINT "ClientImportJob_engine_valid" CHECK ("engine" IN ('LEGACY', 'SMART'));

-- Project integrity (MULTI_PROJECT_PLAN.md §10.7).
CREATE TRIGGER "ClientImportRow_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientImportRow" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientImportPreset_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientImportPreset" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "ClientImportRow_jobId_same_project" AFTER INSERT OR UPDATE OF "jobId", "projectId" ON "ClientImportRow" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ClientImportJob', 'jobId');
CREATE CONSTRAINT TRIGGER "ClientImportRow_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientImportRow" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');
