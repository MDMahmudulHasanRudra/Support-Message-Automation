-- Post-conversation CSAT surveys (CSAT.md, feature CSAT_SURVEYS, off by default). Additive only: two enums and
-- two new tables. No existing table or row is touched. The retired Teams tables that `prisma migrate diff`
-- proposes to drop are deliberately left alone (CLAUDE.md, "Microsoft Teams Integration — REMOVED").

-- CreateEnum
CREATE TYPE "CsatChannel" AS ENUM ('WHATSAPP_PERSONAL', 'WEBCHAT', 'MESSENGER', 'INSTAGRAM', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "CsatSurveyStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED');

-- CreateTable
CREATE TABLE "CsatSurvey" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "channel" "CsatChannel" NOT NULL,
    "channelConversationId" TEXT,
    "accountId" TEXT,
    "chatId" TEXT,
    "resolutionEventId" TEXT NOT NULL,
    "customerKey" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL,
    "resolvedById" TEXT,
    "teamId" TEXT,
    "status" "CsatSurveyStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "question" TEXT,
    "sentAt" TIMESTAMP(3),
    "outboundMessageId" TEXT,
    "channelMessageId" TEXT,
    "answerClosedAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "rating" INTEGER,
    "comment" TEXT,
    "answerSource" TEXT,
    "answerMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CsatSurvey_pkey" PRIMARY KEY ("id"),
    -- Exactly one conversation: a channel conversation, or a WhatsApp chat (the ConversationEvent shape).
    CONSTRAINT "CsatSurvey_one_conversation" CHECK (
      ("channelConversationId" IS NOT NULL AND "accountId" IS NULL AND "chatId" IS NULL)
      OR ("channelConversationId" IS NULL AND "accountId" IS NOT NULL AND "chatId" IS NOT NULL)
    ),
    -- Never in a WhatsApp group, whatever the code above this says.
    CONSTRAINT "CsatSurvey_never_a_group" CHECK ("chatId" IS NULL OR "chatId" NOT LIKE '%@g.us'),
    CONSTRAINT "CsatSurvey_whatsapp_channel" CHECK (("accountId" IS NOT NULL) = ("channel" = 'WHATSAPP_PERSONAL')),
    CONSTRAINT "CsatSurvey_rating_range" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5),
    CONSTRAINT "CsatSurvey_answer_whole" CHECK (("answeredAt" IS NULL) = ("rating" IS NULL)),
    CONSTRAINT "CsatSurvey_answer_needs_ask" CHECK ("answeredAt" IS NULL OR ("status" = 'SENT' AND "answerClosedAt" IS NOT NULL)),
    CONSTRAINT "CsatSurvey_sent_has_time" CHECK (("status" = 'SENT') = ("sentAt" IS NOT NULL)),
    CONSTRAINT "CsatSurvey_comment_length" CHECK ("comment" IS NULL OR char_length("comment") <= 1000),
    CONSTRAINT "CsatSurvey_answer_source" CHECK ("answerSource" IS NULL OR "answerSource" IN ('WIDGET', 'MESSAGE'))
);

-- CreateTable
CREATE TABLE "CsatSettings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "whatsappPersonalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webchatEnabled" BOOLEAN NOT NULL DEFAULT false,
    "messengerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "instagramEnabled" BOOLEAN NOT NULL DEFAULT false,
    "telegramEnabled" BOOLEAN NOT NULL DEFAULT false,
    "questionText" TEXT,
    "cooldownDays" INTEGER NOT NULL DEFAULT 7,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CsatSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CsatSettings_cooldown_range" CHECK ("cooldownDays" BETWEEN 0 AND 365),
    CONSTRAINT "CsatSettings_question_length" CHECK ("questionText" IS NULL OR char_length("questionText") <= 500)
);

-- CreateIndex
CREATE UNIQUE INDEX "CsatSurvey_resolutionEventId_key" ON "CsatSurvey"("resolutionEventId");

-- CreateIndex
CREATE UNIQUE INDEX "CsatSurvey_outboundMessageId_key" ON "CsatSurvey"("outboundMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "CsatSurvey_channelMessageId_key" ON "CsatSurvey"("channelMessageId");

-- CreateIndex
CREATE INDEX "CsatSurvey_projectId_status_createdAt_idx" ON "CsatSurvey"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CsatSurvey_projectId_sentAt_idx" ON "CsatSurvey"("projectId", "sentAt");

-- CreateIndex
CREATE INDEX "CsatSurvey_projectId_customerKey_sentAt_idx" ON "CsatSurvey"("projectId", "customerKey", "sentAt");

-- CreateIndex
CREATE INDEX "CsatSurvey_projectId_accountId_chatId_sentAt_idx" ON "CsatSurvey"("projectId", "accountId", "chatId", "sentAt");

-- CreateIndex
CREATE INDEX "CsatSurvey_channelConversationId_sentAt_idx" ON "CsatSurvey"("channelConversationId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "CsatSettings_projectId_key" ON "CsatSettings"("projectId");

-- AddForeignKey
ALTER TABLE "CsatSurvey" ADD CONSTRAINT "CsatSurvey_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsatSurvey" ADD CONSTRAINT "CsatSurvey_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "ChannelConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsatSurvey" ADD CONSTRAINT "CsatSurvey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsatSurvey" ADD CONSTRAINT "CsatSurvey_resolutionEventId_fkey" FOREIGN KEY ("resolutionEventId") REFERENCES "ConversationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsatSurvey" ADD CONSTRAINT "CsatSurvey_outboundMessageId_fkey" FOREIGN KEY ("outboundMessageId") REFERENCES "OutboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsatSurvey" ADD CONSTRAINT "CsatSurvey_channelMessageId_fkey" FOREIGN KEY ("channelMessageId") REFERENCES "ChannelMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsatSettings" ADD CONSTRAINT "CsatSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database integrity (MULTI_PROJECT_PLAN.md §10.7): every parent in the survey's own project, and a fixed project.
CREATE CONSTRAINT TRIGGER "CsatSurvey_channelConversationId_same_project" AFTER INSERT OR UPDATE OF "channelConversationId", "projectId" ON "CsatSurvey" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'channelConversationId');
CREATE CONSTRAINT TRIGGER "CsatSurvey_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "CsatSurvey" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "CsatSurvey_resolutionEventId_same_project" AFTER INSERT OR UPDATE OF "resolutionEventId", "projectId" ON "CsatSurvey" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ConversationEvent', 'resolutionEventId');
CREATE CONSTRAINT TRIGGER "CsatSurvey_outboundMessageId_same_project" AFTER INSERT OR UPDATE OF "outboundMessageId", "projectId" ON "CsatSurvey" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('OutboundMessage', 'outboundMessageId');
CREATE CONSTRAINT TRIGGER "CsatSurvey_channelMessageId_same_project" AFTER INSERT OR UPDATE OF "channelMessageId", "projectId" ON "CsatSurvey" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelMessage', 'channelMessageId');
CREATE TRIGGER "CsatSurvey_projectId_immutable" BEFORE UPDATE OF "projectId" ON "CsatSurvey" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "CsatSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "CsatSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- An answer is final. Once answered, the rating, the comment, when and how it came, and which message carried it
-- never change — for Prisma and raw SQL alike. Deletion stays possible (a conversation's surveys go with it, and a
-- removed customer's data is emptied table by table); rewriting is not.
CREATE OR REPLACE FUNCTION csat_answer_append_only() RETURNS trigger AS $$
BEGIN
  IF OLD."answeredAt" IS NOT NULL AND (
       NEW."answeredAt" IS DISTINCT FROM OLD."answeredAt"
    OR NEW."rating" IS DISTINCT FROM OLD."rating"
    OR NEW."comment" IS DISTINCT FROM OLD."comment"
    OR NEW."answerSource" IS DISTINCT FROM OLD."answerSource"
    OR NEW."answerMessageId" IS DISTINCT FROM OLD."answerMessageId"
    OR NEW."answerClosedAt" IS DISTINCT FROM OLD."answerClosedAt"
    OR NEW."status" IS DISTINCT FROM OLD."status"
  ) THEN
    RAISE EXCEPTION 'A satisfaction survey answer cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CsatSurvey_answer_append_only" BEFORE UPDATE ON "CsatSurvey" FOR EACH ROW EXECUTE FUNCTION csat_answer_append_only();

-- The worker's dispatch reads only waiting surveys.
CREATE INDEX "CsatSurvey_pending_idx" ON "CsatSurvey"("projectId", "createdAt") WHERE "status" = 'PENDING';
