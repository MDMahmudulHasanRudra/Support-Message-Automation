-- CreateEnum
CREATE TYPE "RuleProposalStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CONVERTED');

-- CreateTable
CREATE TABLE "RuleProposal" (
    "id" TEXT NOT NULL,
    "patternCandidateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "RuleType" NOT NULL,
    "matchType" "MatchType" NOT NULL,
    "matchValue" TEXT,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "cooldownSeconds" INTEGER,
    "replyMessage" TEXT,
    "replyDelayMinMs" INTEGER,
    "replyDelayMaxMs" INTEGER,
    "confidenceScoreSnapshot" INTEGER NOT NULL,
    "status" "RuleProposalStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuleProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RuleProposal_patternCandidateId_key" ON "RuleProposal"("patternCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleProposal_createdRuleId_key" ON "RuleProposal"("createdRuleId");

-- CreateIndex
CREATE INDEX "RuleProposal_status_confidenceScoreSnapshot_idx" ON "RuleProposal"("status", "confidenceScoreSnapshot");

-- AddForeignKey
ALTER TABLE "RuleProposal" ADD CONSTRAINT "RuleProposal_patternCandidateId_fkey" FOREIGN KEY ("patternCandidateId") REFERENCES "PatternCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleProposal" ADD CONSTRAINT "RuleProposal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleProposal" ADD CONSTRAINT "RuleProposal_createdRuleId_fkey" FOREIGN KEY ("createdRuleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
