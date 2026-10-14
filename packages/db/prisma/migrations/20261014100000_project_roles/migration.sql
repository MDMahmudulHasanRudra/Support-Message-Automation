-- Two-level permissions: project roles and project Leads (PROJECT_ROLES.md).
--
-- ADDITIVE ONLY. Two new tables and two permission keys; no existing table, column, index or row is
-- changed. Every user keeps exactly the rights they have: a user with no ProjectMemberRole row (all
-- of them, on the day this is applied) resolves to their global role, as before. ProjectAccess is not
-- touched — it still only says who may enter a project.
--
-- Safe on a live database: CREATE TABLE takes no lock on existing tables beyond the brief one the new
-- foreign keys need on "Project" and "User" (SHARE ROW EXCLUSIVE, which does not block reads or ordinary
-- writes of those rows' data for longer than the catalog update).
--
-- Rollback without data loss: the application ignores both tables when the environment variable
-- PROJECT_ROLES_DISABLED=true is set. Dropping them is only for a database that never used them.

-- CreateTable
CREATE TABLE "ProjectRole" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissionKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMemberRole" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "userId" TEXT NOT NULL,
    "isLead" BOOLEAN NOT NULL DEFAULT false,
    "projectRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectMemberRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRole_projectId_name_key" ON "ProjectRole"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMemberRole_projectId_userId_key" ON "ProjectMemberRole"("projectId", "userId");

-- CreateIndex
CREATE INDEX "ProjectMemberRole_userId_idx" ON "ProjectMemberRole"("userId");

-- CreateIndex
CREATE INDEX "ProjectMemberRole_projectRoleId_idx" ON "ProjectMemberRole"("projectRoleId");

-- AddForeignKey
ALTER TABLE "ProjectRole" ADD CONSTRAINT "ProjectRole_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMemberRole" ADD CONSTRAINT "ProjectMemberRole_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMemberRole" ADD CONSTRAINT "ProjectMemberRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMemberRole" ADD CONSTRAINT "ProjectMemberRole_projectRoleId_fkey" FOREIGN KEY ("projectRoleId") REFERENCES "ProjectRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 7 integrity (MULTI_PROJECT_PLAN.md §10.7): a row never changes project, and a member's role is
-- always a role of the same project — refused by PostgreSQL itself, for Prisma and raw SQL alike.
CREATE TRIGGER "ProjectRole_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ProjectRole" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ProjectMemberRole_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ProjectMemberRole" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "ProjectMemberRole_projectRoleId_same_project" AFTER INSERT OR UPDATE OF "projectRoleId", "projectId" ON "ProjectMemberRole" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ProjectRole', 'projectRoleId');

-- A project role can never carry a platform key. The application filters on every write and read
-- (`isProjectAssignableKey`); this is the database's own refusal of the most dangerous ones.
ALTER TABLE "ProjectRole" ADD CONSTRAINT "ProjectRole_no_platform_keys" CHECK (
  NOT ("permissionKeys" && ARRAY[
    'projects.view', 'projects.manage', 'configuration.view', 'configuration.manage',
    'users.view', 'users.create', 'users.edit', 'users.disable', 'users.sessions', 'users.force_logout',
    'permissions.view', 'permissions.create', 'permissions.edit', 'permissions.delete',
    'security_settings.view', 'security_settings.edit',
    'project_members.manage', 'project_roles.manage', 'release_notes.manage'
  ]::TEXT[])
);

-- The two keys. Granted to the Administrator module only (the Main Admin role, which the seed keeps at
-- every key anyway); every other existing role is left exactly as it is. Neither ends in ".view", so the
-- seeded Read Only role does not receive them.
INSERT INTO "Permission" ("id", "key", "label", "category") VALUES
  (gen_random_uuid()::text, 'project_members.manage', 'Manage This Project''s Members', 'Project Administration'),
  (gen_random_uuid()::text, 'project_roles.manage', 'Manage This Project''s Roles', 'Project Administration')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PermissionModulePermission" ("permissionModuleId", "permissionId")
SELECT m."id", p."id"
FROM "PermissionModule" m
JOIN "Permission" p ON p."key" IN ('project_members.manage', 'project_roles.manage')
WHERE m."name" = 'Administrator'
ON CONFLICT DO NOTHING;
