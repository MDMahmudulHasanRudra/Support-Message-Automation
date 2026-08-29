-- Replaces the requireKnowledgeForAiReply boolean added in the previous migration with a mode
-- enum. The boolean could only express "grounded or nothing"; it had no way to say "general
-- conversation is fine, but never guess about our business", which is the distinction that
-- actually matters. Two overlapping switches meaning nearly the same thing is exactly the
-- confusion worth avoiding, so the boolean goes rather than sitting alongside.
--
-- Safe to drop: the column was introduced in an as-yet-undeployed migration, defaults to false,
-- and is read nowhere once this migration lands. STRICT_KNOWLEDGE_ONLY is the stricter of the
-- two states it could hold, so defaulting to it cannot loosen any deployment's behaviour.

-- CreateEnum
CREATE TYPE "AiResponseMode" AS ENUM ('STRICT_KNOWLEDGE_ONLY', 'KNOWLEDGE_PLUS_GENERAL');

-- AlterTable
ALTER TABLE "AiSettings"
DROP COLUMN "requireKnowledgeForAiReply",
ADD COLUMN     "aiResponseMode" "AiResponseMode" NOT NULL DEFAULT 'STRICT_KNOWLEDGE_ONLY',
ADD COLUMN     "generalAnswerMinConfidence" INTEGER NOT NULL DEFAULT 90;
