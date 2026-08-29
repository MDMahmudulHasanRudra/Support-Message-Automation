-- Additive only. Every existing SupportActivity row keeps its exact meaning: `actor` defaults to
-- TEAM_MEMBER, which is what every row written before this migration was.

-- CreateEnum
CREATE TYPE "SupportActivityActor" AS ENUM ('TEAM_MEMBER', 'AI');

-- AlterEnum
-- Postgres 16 permits ADD VALUE inside a transaction so long as the new value is not itself
-- used in the same transaction, which nothing below does.
ALTER TYPE "SupportActivityTriggerType" ADD VALUE 'ANY_MESSAGE';

-- AlterTable
ALTER TABLE "SupportActivity" ADD COLUMN "actor" "SupportActivityActor" NOT NULL DEFAULT 'TEAM_MEMBER';

-- CreateIndex
CREATE INDEX "SupportActivity_accountId_actor_occurredAt_idx" ON "SupportActivity"("accountId", "actor", "occurredAt");
