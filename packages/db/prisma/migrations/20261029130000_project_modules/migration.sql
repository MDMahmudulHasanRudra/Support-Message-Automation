-- Project types and module configuration history (PROJECT_MODULES.md). Additive: every existing
-- project becomes DEFAULT at version 0 and keeps exactly the features it has (no ProjectFeature row
-- is written or changed here).
CREATE TYPE "ProjectType" AS ENUM ('DEFAULT', 'ECOMMERCE', 'CUSTOM_MIX');

ALTER TABLE "Project" ADD COLUMN "projectType" "ProjectType" NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE "Project" ADD COLUMN "projectBaseType" "ProjectType";
ALTER TABLE "Project" ADD COLUMN "moduleConfigVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ProjectModuleConfigChange" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "version" INTEGER NOT NULL,
    "projectType" "ProjectType" NOT NULL,
    "projectBaseType" "ProjectType",
    "previousModules" TEXT[],
    "modules" TEXT[],
    "autoAdded" TEXT[],
    "declined" TEXT[],
    "reason" TEXT,
    "actorUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectModuleConfigChange_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectModuleConfigChange_projectId_version_key" ON "ProjectModuleConfigChange"("projectId", "version");
CREATE INDEX "ProjectModuleConfigChange_projectId_createdAt_idx" ON "ProjectModuleConfigChange"("projectId", "createdAt");

ALTER TABLE "ProjectModuleConfigChange" ADD CONSTRAINT "ProjectModuleConfigChange_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "ProjectModuleConfigChange_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ProjectModuleConfigChange" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- History is append-only: a change is recorded once and never rewritten.
CREATE OR REPLACE FUNCTION project_module_config_change_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ProjectModuleConfigChange rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ProjectModuleConfigChange_append_only" BEFORE UPDATE ON "ProjectModuleConfigChange" FOR EACH ROW EXECUTE FUNCTION project_module_config_change_append_only();
