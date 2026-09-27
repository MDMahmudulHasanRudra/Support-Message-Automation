-- AI "unable to understand" holding reply: a toggle (off by default), the admin's wording (null =
-- the built-in default) and a per-conversation repeat window on AiSettings, plus a pointer on
-- AiFallbackDecision to the holding reply a handover sent. Additive; nothing existing changes.
-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN     "unableToUnderstandRepeatMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "unableToUnderstandReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unableToUnderstandReplyText" TEXT;

-- AlterTable
ALTER TABLE "AiFallbackDecision" ADD COLUMN     "holdingReplyOutboundMessageId" TEXT;

