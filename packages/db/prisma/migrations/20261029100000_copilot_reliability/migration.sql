-- AI Copilot reliability (INBOX_WORKSPACE.md § Reliability). Additive.
-- Rollback: DROP INDEX "AiDraft_one_active_whatsapp", "AiDraft_one_active_channel",
--           "AiDraft_status_leaseExpiresAt_idx", "AiDraft_requestedById_createdAt_idx";
--           ALTER TABLE "AiDraft" DROP COLUMN "attempts", DROP COLUMN "leaseExpiresAt";
--           (the CANCELLED enum value cannot be dropped; it is harmless when unused)

-- AlterEnum
ALTER TYPE "AiDraftStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "AiDraft" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AiDraft_status_leaseExpiresAt_idx" ON "AiDraft"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "AiDraft_requestedById_createdAt_idx" ON "AiDraft"("requestedById", "createdAt");

-- Before the uniqueness below can hold: should two active requests by one person for one conversation
-- already exist (only possible before this migration), every one but the newest is closed as FAILED.
UPDATE "AiDraft" d SET "status" = 'FAILED', "error" = 'Superseded by a newer request.', "completedAt" = CURRENT_TIMESTAMP
WHERE d."status" IN ('PENDING', 'PROCESSING') AND d."requestedById" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "AiDraft" n
    WHERE n."status" IN ('PENDING', 'PROCESSING') AND n."requestedById" = d."requestedById"
      AND n."accountId" IS NOT DISTINCT FROM d."accountId" AND n."chatId" IS NOT DISTINCT FROM d."chatId"
      AND n."channelConversationId" IS NOT DISTINCT FROM d."channelConversationId"
      AND (n."createdAt", n."id") > (d."createdAt", d."id")
  );

-- At most ONE active request per person per conversation, enforced by the database: two concurrent
-- requests cannot both pass, so a double click can never pay for two AI calls. Completed history is
-- outside the predicate and unlimited.
CREATE UNIQUE INDEX "AiDraft_one_active_whatsapp" ON "AiDraft"("requestedById", "accountId", "chatId")
  WHERE "status" IN ('PENDING', 'PROCESSING') AND "channelConversationId" IS NULL AND "requestedById" IS NOT NULL;
CREATE UNIQUE INDEX "AiDraft_one_active_channel" ON "AiDraft"("requestedById", "channelConversationId")
  WHERE "status" IN ('PENDING', 'PROCESSING') AND "channelConversationId" IS NOT NULL AND "requestedById" IS NOT NULL;
