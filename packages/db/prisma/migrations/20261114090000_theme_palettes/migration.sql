-- Colour themes (lib/themes.ts). Both nullable and additive: NULL keeps today's look ("tide") for every
-- existing installation and every existing person, and nothing is rewritten.

-- The installation's default theme, set on Main Admin → Branding.
ALTER TABLE "PlatformBranding" ADD COLUMN "themePalette" TEXT;

-- A person's own choice, set on My account → Appearance. NULL = the installation's default.
ALTER TABLE "User" ADD COLUMN "themePalette" TEXT;
