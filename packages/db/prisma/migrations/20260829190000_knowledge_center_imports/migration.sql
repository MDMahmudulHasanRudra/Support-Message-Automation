-- Additive only. Existing AiKnowledgeItem rows gain two nullable columns and keep their exact
-- meaning; the new setting defaults to the behaviour that was already in place.

-- CreateEnum
CREATE TYPE "KnowledgeImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "KnowledgeImportSourceType" AS ENUM ('PASTED_TEXT', 'DOCUMENT');

-- CreateTable
CREATE TABLE "KnowledgeImport" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sourceType" "KnowledgeImportSourceType" NOT NULL DEFAULT 'PASTED_TEXT',
    "rawText" TEXT NOT NULL,
    "module" TEXT,
    "status" "KnowledgeImportStatus" NOT NULL DEFAULT 'PENDING',
    "chunksTotal" INTEGER NOT NULL DEFAULT 0,
    "chunksDone" INTEGER NOT NULL DEFAULT 0,
    "entriesCreated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeImport_status_createdAt_idx" ON "KnowledgeImport"("status", "createdAt");

-- AlterTable
ALTER TABLE "AiKnowledgeItem"
ADD COLUMN     "importId" TEXT,
ADD COLUMN     "sourceLabel" TEXT;

-- CreateIndex
CREATE INDEX "AiKnowledgeItem_importId_idx" ON "AiKnowledgeItem"("importId");

-- CreateIndex
-- The review queue's own query shape: everything still waiting to be checked, newest first.
CREATE INDEX "AiKnowledgeItem_humanVerified_createdAt_idx" ON "AiKnowledgeItem"("humanVerified", "createdAt");

-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN "requireKnowledgeForAiReply" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "KnowledgeImport" ADD CONSTRAINT "KnowledgeImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, not Cascade: deleting an import record must not erase what was learned from it.
ALTER TABLE "AiKnowledgeItem" ADD CONSTRAINT "AiKnowledgeItem_importId_fkey" FOREIGN KEY ("importId") REFERENCES "KnowledgeImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
