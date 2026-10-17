-- Deleting in Clients is the Administrator's by default (owner's rule, 17 Oct 2026). An Administrator
-- may give `clients.delete` to a global role (the app refuses anyone else adding it: adminGrantRefusal);
-- it is never project-assignable, so no project role or Lead carries it.
--
-- Since 17 Oct 2026 the key alone already granted nothing (deleting needed a Main Admin), so removing
-- it from roles changes nothing anybody can do today — it only stops it starting to work for roles
-- that were given it under the old meaning.
--
-- Rollback: re-add the rows if wanted, and
--   ALTER TABLE "ProjectRole" DROP CONSTRAINT "ProjectRole_no_platform_keys"; then recreate it without 'clients.delete';
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261017200000_clients_delete_admin_granted';

-- Global roles: keep the key only on Main Admin roles (those holding projects.manage).
DELETE FROM "PermissionModulePermission" pmp
USING "Permission" p
WHERE pmp."permissionId" = p."id"
  AND p."key" = 'clients.delete'
  AND NOT EXISTS (
    SELECT 1 FROM "PermissionModulePermission" x
    JOIN "Permission" q ON q."id" = x."permissionId"
    WHERE x."permissionModuleId" = pmp."permissionModuleId" AND q."key" = 'projects.manage'
  );

-- Project roles never carry it.
UPDATE "ProjectRole" SET "permissionKeys" = array_remove("permissionKeys", 'clients.delete') WHERE 'clients.delete' = ANY("permissionKeys");

ALTER TABLE "ProjectRole" DROP CONSTRAINT "ProjectRole_no_platform_keys";
ALTER TABLE "ProjectRole" ADD CONSTRAINT "ProjectRole_no_platform_keys" CHECK (
  NOT ("permissionKeys" && ARRAY[
    'projects.view', 'projects.manage', 'configuration.view', 'configuration.manage',
    'users.view', 'users.create', 'users.edit', 'users.disable', 'users.sessions', 'users.force_logout',
    'permissions.view', 'permissions.create', 'permissions.edit', 'permissions.delete',
    'security_settings.view', 'security_settings.edit',
    'project_members.manage', 'project_roles.manage', 'release_notes.manage',
    'clients.delete'
  ]::TEXT[])
);
