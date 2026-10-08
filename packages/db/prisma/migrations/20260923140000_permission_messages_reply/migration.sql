-- Permission enforcement across every module, and the one new key it needed.
--
-- Until this release most modules enforced nothing: the roles assigned on Permission Modules
-- governed five modules, and everywhere else any logged-in user could open the page and use every
-- button — including a "Read Only" role described as "View-only access across every module".
-- Enforcing the existing keys is a code change. This migration only handles the key that did not
-- exist yet.
--
-- `messages.reply`: Messages had only `.view`, from before the chat inbox could send. Without a key
-- of its own, replying would have been gated on either `messages.view` (so Read Only could reply to
-- customers) or `whatsapp.manage` (so support staff could not reply without an admin-level key).
--
-- The row is inserted here rather than left to the seed because the grant below needs it, and the
-- seed runs AFTER migrations. The seed upserts permissions by key, so it simply adopts this row.
INSERT INTO "Permission" ("id", "key", "label", "category")
VALUES (gen_random_uuid()::text, 'messages.reply', 'Reply in WhatsApp Chat', 'Messages')
ON CONFLICT ("key") DO NOTHING;

-- Every CUSTOM role that can see Messages keeps the ability to reply that it had yesterday. Without
-- this, turning enforcement on would silently stop those users answering customers the moment the
-- deploy finished, and nothing on screen would say why. An administrator can untick it afterwards.
--
-- System roles are excluded on purpose: the seed rewrites their permissions from code on every run
-- (packages/shared/src/permissions.ts), where Support Manager and Support Agent now include it and
-- Read Only, being `.view` keys only, does not.
INSERT INTO "PermissionModulePermission" ("permissionModuleId", "permissionId")
SELECT pmp."permissionModuleId", reply."id"
FROM "PermissionModulePermission" pmp
JOIN "Permission" viewing ON viewing."id" = pmp."permissionId" AND viewing."key" = 'messages.view'
JOIN "PermissionModule" pm ON pm."id" = pmp."permissionModuleId" AND pm."isSystem" = false
CROSS JOIN (SELECT "id" FROM "Permission" WHERE "key" = 'messages.reply') reply
ON CONFLICT DO NOTHING;
