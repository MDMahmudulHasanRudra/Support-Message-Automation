-- Contacts are collected from every conversation, past ones included, in every project (CONTACTS.md, 13 Nov 2026).
-- Nothing is sent and nothing is deleted: the collector only saves numbers, emails and links customers wrote.

ALTER TABLE "ContactSettings" ALTER COLUMN "autoCreateFromChats" SET DEFAULT true;

-- Existing projects: switch collecting on and start the scan again from the oldest stored message.
-- The AI switch is left as it was.
UPDATE "ContactSettings"
SET "autoCreateFromChats" = true,
    "collectionStartedAt" = COALESCE("collectionStartedAt", now()),
    "whatsappCursorAt" = NULL,
    "whatsappCursorId" = NULL,
    "channelCursorAt" = NULL,
    "updatedAt" = now();

-- Projects with no settings yet: the same, with the serial counter continuing after any contact already numbered.
INSERT INTO "ContactSettings" ("id", "projectId", "lastSerial", "aiCollectionEnabled", "autoCreateFromChats", "collectionStartedAt", "updatedAt")
SELECT
  'cs' || replace(gen_random_uuid()::text, '-', ''),
  p.id,
  COALESCE((SELECT max(c."serial") FROM "Contact" c WHERE c."projectId" = p.id), 0),
  false,
  true,
  now(),
  now()
FROM "Project" p
WHERE NOT EXISTS (SELECT 1 FROM "ContactSettings" s WHERE s."projectId" = p.id);
