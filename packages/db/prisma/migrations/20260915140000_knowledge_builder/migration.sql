-- Knowledge Builder — on-demand "Learn from Conversations".
--
-- Two new tables and three new enums. As with the AI Sandbox migration before it,
-- nothing here alters an existing table: the Prisma relation fields added to
-- "User" and "WhatsAppGroup" are virtual (both foreign keys live on
-- "ConversationCandidate"), so neither table is touched.
--
-- "ConversationCandidate"."category" reuses the existing "AiKnowledgeCategory"
-- type rather than introducing a parallel one — a candidate becomes an
-- AiKnowledgeItem on approval, and two category vocabularies that had to be kept
-- in sync by hand is exactly the drift this schema avoids elsewhere.
--
-- Note what is deliberately absent: no change to
-- "WhatsAppGroup"."knowledgeBuiltAt"/"knowledgeBuiltThroughAt". Those are the
-- background knowledge builder's incremental watermark, and this feature must
-- never move them — doing so would make that job skip conversations nobody has
-- learned from yet.

CREATE TYPE "ConversationRangeKind" AS ENUM ('LATEST_MESSAGES', 'LAST_24_HOURS', 'LAST_7_DAYS', 'CUSTOM');
CREATE TYPE "ConversationAnalysisStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED');
CREATE TYPE "ConversationCandidateStatus" AS ENUM ('WAITING', 'APPROVED', 'REJECTED');

CREATE TABLE "ConversationAnalysisRun" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "groupIds" TEXT[],
    "rangeKind" "ConversationRangeKind" NOT NULL,
    "rangeStart" TIMESTAMP(3),
    "rangeEnd" TIMESTAMP(3),
    "messageLimit" INTEGER,
    "status" "ConversationAnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "groupsTotal" INTEGER NOT NULL DEFAULT 0,
    "groupsDone" INTEGER NOT NULL DEFAULT 0,
    "candidatesCreated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ConversationAnalysisRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversationCandidate" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "groupId" TEXT,
    "groupName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "AiKnowledgeCategory" NOT NULL,
    "question" TEXT,
    "answer" TEXT NOT NULL,
    "module" TEXT,
    "confidence" INTEGER NOT NULL,
    "status" "ConversationCandidateStatus" NOT NULL DEFAULT 'WAITING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "promotedKnowledgeItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationCandidate_pkey" PRIMARY KEY ("id")
);

-- The worker's claim query, then the run list's own ordering.
CREATE INDEX "ConversationAnalysisRun_status_createdAt_idx" ON "ConversationAnalysisRun"("status", "createdAt");
CREATE INDEX "ConversationAnalysisRun_createdAt_idx" ON "ConversationAnalysisRun"("createdAt");
CREATE INDEX "ConversationCandidate_runId_createdAt_idx" ON "ConversationCandidate"("runId", "createdAt");
-- The review list's shape, mirroring "AiKnowledgeItem"'s own humanVerified index.
CREATE INDEX "ConversationCandidate_status_createdAt_idx" ON "ConversationCandidate"("status", "createdAt");

-- Cascade from the run: a candidate has no meaning without the analysis that produced it.
-- SetNull everywhere else: deactivating a group or a user must never delete review history.
ALTER TABLE "ConversationAnalysisRun" ADD CONSTRAINT "ConversationAnalysisRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationCandidate" ADD CONSTRAINT "ConversationCandidate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ConversationAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationCandidate" ADD CONSTRAINT "ConversationCandidate_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationCandidate" ADD CONSTRAINT "ConversationCandidate_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
