-- CreateEnum
CREATE TYPE "PatternCandidateStatus" AS ENUM ('PENDING_ANALYSIS', 'ANALYZED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'MERGED', 'EXPIRED');

-- CreateTable
CREATE TABLE "PatternCandidate" (
    "id" TEXT NOT NULL,
    "patternKey" TEXT NOT NULL,
    "suggestedMatchType" "MatchType" NOT NULL,
    "suggestedKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "suggestedMatchValue" TEXT,
    "suggestedReplyMessage" TEXT,
    "suggestedActionCategory" TEXT,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "distinctGroupCount" INTEGER NOT NULL DEFAULT 0,
    "distinctClientCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "frequencyScore" INTEGER NOT NULL DEFAULT 0,
    "diversityScore" INTEGER NOT NULL DEFAULT 0,
    "consistencyScore" INTEGER NOT NULL DEFAULT 0,
    "resolutionScore" INTEGER NOT NULL DEFAULT 0,
    "recencyScore" INTEGER NOT NULL DEFAULT 0,
    "aiConfidenceScore" INTEGER,
    "humanVerifiedBoost" INTEGER NOT NULL DEFAULT 0,
    "confidenceScore" INTEGER NOT NULL DEFAULT 0,
    "status" "PatternCandidateStatus" NOT NULL DEFAULT 'PENDING_ANALYSIS',
    "aiAnalysisSummary" TEXT,
    "aiProviderId" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatternCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatternCandidateEvidence" (
    "id" TEXT NOT NULL,
    "patternCandidateId" TEXT NOT NULL,
    "conversationSessionId" TEXT NOT NULL,
    "matchedMessageId" TEXT,
    "wasResolved" BOOLEAN NOT NULL DEFAULT false,
    "respondingRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatternCandidateEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatternCandidate_patternKey_key" ON "PatternCandidate"("patternKey");

-- CreateIndex
CREATE INDEX "PatternCandidate_status_confidenceScore_idx" ON "PatternCandidate"("status", "confidenceScore");

-- CreateIndex
CREATE INDEX "PatternCandidate_lastSeenAt_idx" ON "PatternCandidate"("lastSeenAt");

-- CreateIndex
CREATE INDEX "PatternCandidateEvidence_patternCandidateId_idx" ON "PatternCandidateEvidence"("patternCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX "PatternCandidateEvidence_patternCandidateId_conversationSes_key" ON "PatternCandidateEvidence"("patternCandidateId", "conversationSessionId");

-- AddForeignKey
ALTER TABLE "PatternCandidate" ADD CONSTRAINT "PatternCandidate_aiProviderId_fkey" FOREIGN KEY ("aiProviderId") REFERENCES "AiProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatternCandidate" ADD CONSTRAINT "PatternCandidate_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatternCandidate" ADD CONSTRAINT "PatternCandidate_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "PatternCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatternCandidateEvidence" ADD CONSTRAINT "PatternCandidateEvidence_patternCandidateId_fkey" FOREIGN KEY ("patternCandidateId") REFERENCES "PatternCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatternCandidateEvidence" ADD CONSTRAINT "PatternCandidateEvidence_conversationSessionId_fkey" FOREIGN KEY ("conversationSessionId") REFERENCES "ConversationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatternCandidateEvidence" ADD CONSTRAINT "PatternCandidateEvidence_matchedMessageId_fkey" FOREIGN KEY ("matchedMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
