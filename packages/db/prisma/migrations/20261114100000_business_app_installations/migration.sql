-- Business Apps foundation (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md). Additive only: one new project-owned
-- table. No existing row, project, module selection or setting is changed, and nothing is installed anywhere:
-- a project has a Business App only when a Main Admin adds one.

-- CreateTable
CREATE TABLE "ProjectAppInstallation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "appKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "contractVersion" TEXT NOT NULL,
    "externalWorkspaceId" TEXT,
    "lastConnectedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "installedById" TEXT,
    "installedByName" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAppInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAppInstallation_projectId_appKey_key" ON "ProjectAppInstallation"("projectId", "appKey");

-- AddForeignKey
ALTER TABLE "ProjectAppInstallation" ADD CONSTRAINT "ProjectAppInstallation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The registry's keys and the installation states (packages/shared businessApps.ts states the same lists).
ALTER TABLE "ProjectAppInstallation" ADD CONSTRAINT "ProjectAppInstallation_appKey_check" CHECK ("appKey" IN ('commerce', 'education', 'travel'));
ALTER TABLE "ProjectAppInstallation" ADD CONSTRAINT "ProjectAppInstallation_status_check" CHECK ("status" IN ('PENDING', 'CONNECTING', 'ACTIVE', 'DISABLED', 'ERROR'));
-- Never Connected without proof: ACTIVE needs the time the app last answered and the workspace id it gave.
ALTER TABLE "ProjectAppInstallation" ADD CONSTRAINT "ProjectAppInstallation_active_verified_check" CHECK ("status" <> 'ACTIVE' OR ("lastConnectedAt" IS NOT NULL AND "externalWorkspaceId" IS NOT NULL));
ALTER TABLE "ProjectAppInstallation" ADD CONSTRAINT "ProjectAppInstallation_error_length_check" CHECK ("lastError" IS NULL OR length("lastError") <= 500);

-- Database integrity (MULTI_PROJECT_PLAN.md §10.7): a row never changes project. It references no other
-- project-owned table (the people are login ids without a foreign key), so it needs no same-project trigger.
CREATE TRIGGER "ProjectAppInstallation_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ProjectAppInstallation" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
