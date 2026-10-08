-- Rate-limit defaults retuned for a product where the AI answers customers, rather than one that
-- sends a single acknowledgement. Every automatic message this system sends is a REPLY to an
-- incoming customer message, so the per-client numbers were capping how many of a customer's own
-- questions got answered, not preventing spam.
--
-- Defaults only: the settings singleton already exists on every running deployment and is not
-- touched here, so an operator's own tuning is preserved. This changes what a fresh install gets.
ALTER TABLE "AutomationSettings" ALTER COLUMN "maxRepliesPerClientPerHour" SET DEFAULT 60;
ALTER TABLE "AutomationSettings" ALTER COLUMN "maxRepliesPerClientPerDay" SET DEFAULT 500;
ALTER TABLE "AutomationSettings" ALTER COLUMN "globalMaxPerMinute" SET DEFAULT 20;
ALTER TABLE "AutomationSettings" ALTER COLUMN "globalMaxPerHour" SET DEFAULT 600;
ALTER TABLE "AutomationSettings" ALTER COLUMN "globalMaxPerDay" SET DEFAULT 5000;
