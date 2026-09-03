-- Softify Forge integration: product knowledge sourced from the ISPDIGITAL repository.

-- A file read out of the repository is a new kind of knowledge import.
ALTER TYPE "KnowledgeImportSourceType" ADD VALUE IF NOT EXISTS 'FORGE_REPO';

-- Lifecycle of one "the docs did not answer this, go read the code" task.
DO $$ BEGIN
  CREATE TYPE "ForgeResearchStatus" AS ENUM ('PENDING', 'PROCESSING', 'ANSWERED', 'NO_ANSWER', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ForgeSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT,
    "projectName" TEXT,
    "syncUserGuides" BOOLEAN NOT NULL DEFAULT true,
    "syncModuleGuides" BOOLEAN NOT NULL DEFAULT true,
    "researchUnanswered" BOOLEAN NOT NULL DEFAULT false,
    "autoVerifyUserGuides" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastSyncCompletedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ForgeSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ForgeResearchTask" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "fallbackDecisionId" TEXT,
    "signature" TEXT NOT NULL,
    "askedCount" INTEGER NOT NULL DEFAULT 1,
    "status" "ForgeResearchStatus" NOT NULL DEFAULT 'PENDING',
    "moduleSlug" TEXT,
    "error" TEXT,
    "producedItemId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ForgeResearchTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ForgeResearchTask_fallbackDecisionId_key" ON "ForgeResearchTask"("fallbackDecisionId");
CREATE UNIQUE INDEX IF NOT EXISTS "ForgeResearchTask_signature_key" ON "ForgeResearchTask"("signature");
CREATE INDEX IF NOT EXISTS "ForgeResearchTask_status_scheduledAt_idx" ON "ForgeResearchTask"("status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "ForgeResearchTask_askedCount_idx" ON "ForgeResearchTask"("askedCount");

DO $$ BEGIN
  ALTER TABLE "ForgeResearchTask"
    ADD CONSTRAINT "ForgeResearchTask_fallbackDecisionId_fkey"
    FOREIGN KEY ("fallbackDecisionId") REFERENCES "AiFallbackDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The dashboard's "Sync now" button.
ALTER TYPE "WorkerCommandType" ADD VALUE IF NOT EXISTS 'FORGE_SYNC_NOW';
