-- Automated-reply disclosure for AI replies on Facebook Messenger and Instagram DM only
-- (docs/meta-integration/08-ai-disclosure.md). Additive: off by default, so every existing connection
-- and message behaves exactly as before. Rollback: the four columns can be dropped.
ALTER TABLE "ChannelConnection" ADD COLUMN "aiDisclosureEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "aiDisclosureText" TEXT,
  ADD COLUMN "aiDisclosureIdleHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "ChannelMessage" ADD COLUMN "aiDisclosed" BOOLEAN NOT NULL DEFAULT false;
