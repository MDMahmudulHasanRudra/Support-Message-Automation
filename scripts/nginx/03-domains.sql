-- Chithii addresses (Nov 2026). New addresses ACTIVE; the getassist.pro ones drop to VERIFIED so they still
-- route (webhooks, widget) but are never handed out (pickCustomerOrigin prefers ACTIVE). admin.chithii.com first
-- (adminHostnames[0] is the platform address shown in links).
BEGIN;
INSERT INTO "CustomerDomain" (id, "customerId", hostname, status, "verificationToken", "verifiedAt", "activatedAt", "createdByUsername", "createdAt", "updatedAt")
SELECT v.id, d."customerId", v.hostname, 'ACTIVE', md5(random()::text || clock_timestamp()::text), now(), now(), 'rudra', now(), now()
FROM (VALUES ('chithii_app_domain', 'app.chithii.com', 'demo.getassist.pro'),
             ('chithii_noorvip_domain', 'noorvip.chithii.com', 'noorvip.getassist.pro')) AS v(id, hostname, old)
JOIN "CustomerDomain" d ON d.hostname = v.old
ON CONFLICT (hostname) DO NOTHING;
UPDATE "CustomerDomain" SET status = 'VERIFIED', "updatedAt" = now() WHERE hostname IN ('demo.getassist.pro', 'noorvip.getassist.pro') AND status = 'ACTIVE';
UPDATE "PlatformDomainSettings" SET "adminHostnames" = ARRAY['admin.chithii.com', 'admin.getassist.pro', 'admin.udboy.com']::text[] WHERE id = 'default';
SELECT d.hostname, d.status, c.name FROM "CustomerDomain" d JOIN "Customer" c ON c.id = d."customerId" ORDER BY c.name, d.status;
SELECT "adminHostnames" FROM "PlatformDomainSettings";
COMMIT;
