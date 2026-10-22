-- The Messaging Channels permission keys (OMNICHANNEL.md), and a grant so nobody who answers
-- customers today loses the ability when Messenger / Instagram / Telegram arrive.
--
-- The rows are inserted here rather than left to the seed because the grant below needs one, and the
-- seed runs AFTER migrations. The seed upserts permissions by key, so it simply adopts these rows.
INSERT INTO "Permission" ("id", "key", "label", "category") VALUES
  (gen_random_uuid()::text, 'channels.view', 'View Messaging Channels', 'Messaging Channels'),
  (gen_random_uuid()::text, 'channels.manage', 'Manage Messaging Channels', 'Messaging Channels'),
  (gen_random_uuid()::text, 'conversations.reply', 'Reply on Messenger, Instagram & Telegram', 'Messaging Channels')
ON CONFLICT ("key") DO NOTHING;

-- Every CUSTOM role that may reply in WhatsApp Chat may also reply on the new channels — replying to a
-- customer is the same job whichever app they wrote from. It changes nothing until a Main Admin turns
-- the Omnichannel feature on for a project (it ships off). An administrator can untick it afterwards.
-- System roles are excluded: the seed rewrites them from packages/shared/src/permissions.ts.
INSERT INTO "PermissionModulePermission" ("permissionModuleId", "permissionId")
SELECT pmp."permissionModuleId", reply."id"
FROM "PermissionModulePermission" pmp
JOIN "Permission" whatsapp ON whatsapp."id" = pmp."permissionId" AND whatsapp."key" = 'messages.reply'
JOIN "PermissionModule" pm ON pm."id" = pmp."permissionModuleId" AND pm."isSystem" = false
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "key" = 'conversations.reply') reply
ON CONFLICT DO NOTHING;
