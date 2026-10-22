-- RELQIVO becomes the built-in product name, and "RELQIVO Project 1" the original project's name on a
-- FRESH install (BRANDING.md §Defaults, 21 Oct 2026). An install that already exists keeps exactly
-- what it shows today. "Existing" means the database already has a user: on a fresh install every
-- migration runs before the seed creates the first one.

-- 1. Existing install: the product name it has been showing came from the old built-in default
--    (a NULL stored value). Store that name, so moving the default to "RELQIVO" changes nothing
--    for it. A name an admin already saved (for example "Noor VIP") is kept as it is.
INSERT INTO "PlatformBranding" ("id", "productName", "updatedAt")
SELECT 'default', 'Softify Assist', CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "User")
ON CONFLICT ("id") DO UPDATE
  SET "productName" = COALESCE("PlatformBranding"."productName", EXCLUDED."productName");

-- 2. Fresh install: the original project, inserted by 20260928150000_projects_foundation, gets the
--    RELQIVO name and slug. Only while it is untouched and nothing has used it: no user, no
--    WhatsApp number, no message. The id (proj_isp_digital) is internal and stays.
UPDATE "Project"
SET "name" = 'RELQIVO Project 1', "slug" = 'relqivo-project-1'
WHERE "id" = 'proj_isp_digital'
  AND "name" = 'ISP Digital'
  AND "slug" = 'isp-digital'
  AND NOT EXISTS (SELECT 1 FROM "User")
  AND NOT EXISTS (SELECT 1 FROM "WhatsAppAccount")
  AND NOT EXISTS (SELECT 1 FROM "Message")
  AND NOT EXISTS (SELECT 1 FROM "Project" p WHERE p."slug" = 'relqivo-project-1');
