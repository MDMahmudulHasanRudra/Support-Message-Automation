-- AI Sandbox — an isolated place to test the AI without a customer being involved.
--
-- Two new tables and three new enums. Nothing here alters an existing table: the
-- Prisma relation fields added to "User" and "WhatsAppGroup" for this feature are
-- virtual (the foreign keys live on the sandbox side), so those tables are not
-- touched by this migration at all. That is deliberate — this feature must be
-- addable and, if it ever came to it, droppable without any production table
-- having been modified.
--
-- Why a separate table rather than an "isTest" flag on "AiFallbackDecision":
-- that table is read by the AI Activity log, by Overview's AI charts, and by
-- Support Activity's actor split. A flag would put test traffic one forgotten
-- WHERE clause away from all three. A separate table cannot be read by accident.

CREATE TYPE "SandboxTurnStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');
CREATE TYPE "SandboxOutcome" AS ENUM ('AI_REPLIED', 'HUMAN_FALLBACK');
CREATE TYPE "SandboxReviewStatus" AS ENUM ('WAITING', 'APPROVED', 'REJECTED');

CREATE TABLE "SandboxSession" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "groupId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SandboxTurn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userMessage" TEXT NOT NULL,
    "status" "SandboxTurnStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" "SandboxOutcome",
    "reason" TEXT,
    "responseText" TEXT,
    "intent" TEXT,
    "scope" TEXT,
    "confidenceScore" INTEGER,
    "modelId" TEXT,
    "tokensUsed" INTEGER,
    "knowledgeTitles" TEXT[],
    "error" TEXT,
    "review" "SandboxReviewStatus" NOT NULL DEFAULT 'WAITING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "promotedKnowledgeItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SandboxTurn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SandboxSession_createdAt_idx" ON "SandboxSession"("createdAt");
CREATE INDEX "SandboxTurn_sessionId_createdAt_idx" ON "SandboxTurn"("sessionId", "createdAt");
-- The worker's claim query: find the oldest PENDING turn.
CREATE INDEX "SandboxTurn_status_createdAt_idx" ON "SandboxTurn"("status", "createdAt");
-- The review list's own shape, mirroring "AiKnowledgeItem"'s humanVerified index.
CREATE INDEX "SandboxTurn_review_createdAt_idx" ON "SandboxTurn"("review", "createdAt");

-- SetNull on both owner references: deactivating a group or a user must never
-- delete the test history that explains why an answer was judged the way it was.
ALTER TABLE "SandboxSession" ADD CONSTRAINT "SandboxSession_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SandboxSession" ADD CONSTRAINT "SandboxSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Cascade: a turn has no meaning outside its own conversation.
ALTER TABLE "SandboxTurn" ADD CONSTRAINT "SandboxTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SandboxSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SandboxTurn" ADD CONSTRAINT "SandboxTurn_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
