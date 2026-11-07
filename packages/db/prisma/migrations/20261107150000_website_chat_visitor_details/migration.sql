-- Website Chat module (WEBSITE_CHAT.md): what a visitor told us on the chat form, and how they arrived.
-- Nullable columns and one default: no table rewrite, nothing existing changes.
ALTER TABLE "WebChatVisitor"
  ADD COLUMN "typedPhone" TEXT,
  ADD COLUMN "customAnswers" JSONB,
  ADD COLUMN "consentAt" TIMESTAMP(3),
  ADD COLUMN "firstPageUrl" TEXT,
  ADD COLUMN "referrer" TEXT,
  ADD COLUMN "utmSource" TEXT,
  ADD COLUMN "utmMedium" TEXT,
  ADD COLUMN "utmCampaign" TEXT,
  ADD COLUMN "browser" TEXT,
  ADD COLUMN "os" TEXT,
  ADD COLUMN "device" TEXT,
  ADD COLUMN "language" TEXT,
  ADD COLUMN "timeZone" TEXT,
  ADD COLUMN "visitCount" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "WebChatVisitor_projectId_lastSeenAt_idx" ON "WebChatVisitor"("projectId", "lastSeenAt");
