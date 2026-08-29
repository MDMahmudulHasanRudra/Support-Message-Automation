-- Additive only. Every new column carries a default that reproduces the behaviour in
-- place before this migration, so deploying it changes nothing until a switch is turned
-- on in AI Settings. No existing row is rewritten and no column is dropped.

-- CreateEnum
CREATE TYPE "AiAutomationScope" AS ENUM ('PER_GROUP', 'ALL_MONITORED_GROUPS');

-- CreateEnum
CREATE TYPE "RuleProposalSource" AS ENUM ('CONVERSATION_LEARNING', 'AI_REPLY');

-- AlterEnum
-- Positioned to match the schema's own declaration order. Postgres 16 allows ADD VALUE
-- inside a transaction provided the new value is not used in that same transaction,
-- which nothing below does.
ALTER TYPE "AiProviderKind" ADD VALUE 'OPENROUTER' BEFORE 'GOOGLE';
ALTER TYPE "AiProviderKind" ADD VALUE 'OLLAMA' BEFORE 'GOOGLE';

-- AlterEnum
ALTER TYPE "WorkerCommandType" ADD VALUE 'BUILD_GROUP_KNOWLEDGE';

-- AlterTable
-- A local Ollama has no API key. Relaxing the column is safe in both directions: every
-- existing row already holds a value, and the application still requires one for every
-- hosted provider kind.
ALTER TABLE "AiProvider" ALTER COLUMN "apiKeyCiphertext" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AiSettings"
ADD COLUMN     "aiAutomationScope" "AiAutomationScope" NOT NULL DEFAULT 'PER_GROUP',
ADD COLUMN     "aiRuleGenerationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiRuleGenerationMinConfidence" INTEGER NOT NULL DEFAULT 95,
ADD COLUMN     "takeoverNotifyGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "knowledgeFromChatEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "knowledgeMinMessagesPerGroup" INTEGER NOT NULL DEFAULT 25;

-- AlterTable
-- An AI_REPLY proposal has no recurring pattern behind it, so the link becomes optional.
-- Postgres permits many NULLs under a unique index, so one-candidate-one-proposal holds.
ALTER TABLE "RuleProposal"
ALTER COLUMN "patternCandidateId" DROP NOT NULL,
ADD COLUMN     "source" "RuleProposalSource" NOT NULL DEFAULT 'CONVERSATION_LEARNING',
ADD COLUMN     "sourceMessageId" TEXT,
ADD COLUMN     "sourceSignature" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RuleProposal_sourceSignature_key" ON "RuleProposal"("sourceSignature");

-- AlterTable
ALTER TABLE "WhatsAppGroup"
ADD COLUMN     "aiAutomationExcluded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "knowledgeBuiltAt" TIMESTAMP(3),
ADD COLUMN     "knowledgeBuiltThroughAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AiKnowledgeItem" ADD COLUMN "sourceGroupId" TEXT;

-- CreateIndex
CREATE INDEX "AiKnowledgeItem_sourceGroupId_idx" ON "AiKnowledgeItem"("sourceGroupId");

-- AddForeignKey
-- SetNull, not Cascade: deleting a group must not erase what was learned from it.
ALTER TABLE "AiKnowledgeItem" ADD CONSTRAINT "AiKnowledgeItem_sourceGroupId_fkey" FOREIGN KEY ("sourceGroupId") REFERENCES "WhatsAppGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
