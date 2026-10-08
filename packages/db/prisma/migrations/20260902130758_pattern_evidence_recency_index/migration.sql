-- DropIndex
DROP INDEX "PatternCandidateEvidence_patternCandidateId_idx";

-- CreateIndex
CREATE INDEX "PatternCandidateEvidence_patternCandidateId_createdAt_idx" ON "PatternCandidateEvidence"("patternCandidateId", "createdAt");
