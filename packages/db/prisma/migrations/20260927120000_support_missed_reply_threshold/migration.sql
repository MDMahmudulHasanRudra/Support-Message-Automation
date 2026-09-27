-- Team Report: how long a customer may wait for a reply before it counts as Missed, for groups that
-- have no support priority (those use their escalation policy's first-alert time). Additive: one
-- column with a default, so every existing settings row gets 30 minutes and nothing is rewritten.
ALTER TABLE "SupportActivitySettings" ADD COLUMN "missedReplyAfterMinutes" INTEGER NOT NULL DEFAULT 30;
