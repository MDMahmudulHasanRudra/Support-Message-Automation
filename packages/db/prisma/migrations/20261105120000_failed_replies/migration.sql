-- Failed customer replies (FAILED_REPLIES.md).
--
-- Additive only. Every new column is nullable or has a constant default (metadata-only in PostgreSQL), so
-- the two queue tables are not rewritten. The retired Teams tables that `prisma migrate diff` proposes to
-- drop are deliberately left alone (CLAUDE.md, "Microsoft Teams Integration — REMOVED").

-- CreateEnum
CREATE TYPE "FailedReplyResolution" AS ENUM ('RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "FailedReplyActionKind" AS ENUM ('RETRY', 'RESOLVE', 'CLOSE', 'REOPEN');

-- AlterTable
ALTER TABLE "ChannelMessage" ADD COLUMN     "lastManualRetryAt" TIMESTAMP(3),
ADD COLUMN     "manualRetryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "replyResolution" "FailedReplyResolution",
ADD COLUMN     "replyResolutionNote" TEXT,
ADD COLUMN     "replyResolvedAt" TIMESTAMP(3),
ADD COLUMN     "replyResolvedById" TEXT;

-- AlterTable
ALTER TABLE "OutboundMessage" ADD COLUMN     "deliveryUncertain" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastManualRetryAt" TIMESTAMP(3),
ADD COLUMN     "manualRetryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "replyResolution" "FailedReplyResolution",
ADD COLUMN     "replyResolutionNote" TEXT,
ADD COLUMN     "replyResolvedAt" TIMESTAMP(3),
ADD COLUMN     "replyResolvedById" TEXT,
ADD COLUMN     "sendStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "FailedReplyAction" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "outboundMessageId" TEXT,
    "channelMessageId" TEXT,
    "action" "FailedReplyActionKind" NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "failureReason" TEXT,
    "confirmedUncertain" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "actorUserId" TEXT,
    "actorUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FailedReplyAction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FailedReplyAction_one_message" CHECK (("outboundMessageId" IS NULL) <> ("channelMessageId" IS NULL))
);

-- CreateIndex
CREATE INDEX "FailedReplyAction_projectId_createdAt_idx" ON "FailedReplyAction"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "FailedReplyAction_outboundMessageId_createdAt_idx" ON "FailedReplyAction"("outboundMessageId", "createdAt");

-- CreateIndex
CREATE INDEX "FailedReplyAction_channelMessageId_createdAt_idx" ON "FailedReplyAction"("channelMessageId", "createdAt");

-- AddForeignKey
ALTER TABLE "FailedReplyAction" ADD CONSTRAINT "FailedReplyAction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailedReplyAction" ADD CONSTRAINT "FailedReplyAction_outboundMessageId_fkey" FOREIGN KEY ("outboundMessageId") REFERENCES "OutboundMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailedReplyAction" ADD CONSTRAINT "FailedReplyAction_channelMessageId_fkey" FOREIGN KEY ("channelMessageId") REFERENCES "ChannelMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database integrity (MULTI_PROJECT_PLAN.md §10.7): same project as the message, and a fixed project.
CREATE CONSTRAINT TRIGGER "FailedReplyAction_outboundMessageId_same_project" AFTER INSERT OR UPDATE OF "outboundMessageId", "projectId" ON "FailedReplyAction" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('OutboundMessage', 'outboundMessageId');
CREATE CONSTRAINT TRIGGER "FailedReplyAction_channelMessageId_same_project" AFTER INSERT OR UPDATE OF "channelMessageId", "projectId" ON "FailedReplyAction" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelMessage', 'channelMessageId');
CREATE TRIGGER "FailedReplyAction_projectId_immutable" BEFORE UPDATE OF "projectId" ON "FailedReplyAction" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- The operator history is append-only. Deletion stays possible (a message's history goes with it, and a
-- removed customer's data is emptied table by table), rewriting is not.
CREATE OR REPLACE FUNCTION failed_reply_action_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Failed reply history rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FailedReplyAction_append_only" BEFORE UPDATE ON "FailedReplyAction" FOR EACH ROW EXECUTE FUNCTION failed_reply_action_append_only();

-- The Failed Replies list reads only failed or retried rows; a small partial index keeps it off the full queue.
CREATE INDEX "OutboundMessage_failed_reply_idx" ON "OutboundMessage"("projectId", "createdAt")
  WHERE "status" IN ('FAILED', 'RATE_LIMITED', 'SKIPPED') OR "manualRetryCount" > 0;
CREATE INDEX "ChannelMessage_failed_reply_idx" ON "ChannelMessage"("projectId", "createdAt")
  WHERE "direction" = 'OUTBOUND' AND ("deliveryStatus" IN ('FAILED', 'UNKNOWN') OR "manualRetryCount" > 0);
