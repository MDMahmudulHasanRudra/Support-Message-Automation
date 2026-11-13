-- Undo 03-domains.sql: back to exactly the state of 13 Nov 2026 17:00 UTC.
BEGIN;
DELETE FROM "CustomerDomain" WHERE id IN ('chithii_app_domain', 'chithii_noorvip_domain');
UPDATE "CustomerDomain" SET status = 'ACTIVE', "updatedAt" = now() WHERE hostname IN ('demo.getassist.pro', 'noorvip.getassist.pro');
UPDATE "PlatformDomainSettings" SET "adminHostnames" = ARRAY['admin.getassist.pro', 'admin.udboy.com']::text[] WHERE id = 'default';
COMMIT;
