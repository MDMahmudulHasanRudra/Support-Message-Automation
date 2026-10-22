-- Google Sheets: each project's own Google OAuth client and an on/off switch (GOOGLE_SHEETS.md §22).
-- Additive: one enum, one new, empty, per-project singleton table, and one nullable column. Nothing
-- existing changes, and nothing is migrated: a project with no row keeps using the server's
-- environment client exactly as before, until a manager saves the project's own.

-- CreateEnum
CREATE TYPE "GoogleOAuthClientStatus" AS ENUM ('UNVALIDATED', 'VALID', 'INVALID');

-- CreateTable
CREATE TABLE "GoogleIntegrationConfig" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "clientId" TEXT,
    "clientSecretCiphertext" TEXT,
    "validationStatus" "GoogleOAuthClientStatus" NOT NULL DEFAULT 'UNVALIDATED',
    "validatedAt" TIMESTAMP(3),
    "validationError" TEXT,
    "credentialsUpdatedAt" TIMESTAMP(3),
    "credentialsUpdatedByUsername" TEXT,
    "enabledChangedAt" TIMESTAMP(3),
    "enabledChangedByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleIntegrationConfig_pkey" PRIMARY KEY ("id")
);

-- One per project.
CREATE UNIQUE INDEX "GoogleIntegrationConfig_projectId_key" ON "GoogleIntegrationConfig"("projectId");

-- AddForeignKey
ALTER TABLE "GoogleIntegrationConfig" ADD CONSTRAINT "GoogleIntegrationConfig_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The client that issued each account's tokens. Existing rows stay NULL = the environment client.
ALTER TABLE "GoogleIntegrationAccount" ADD COLUMN "oauthClientId" TEXT;

-- Phase 7 integrity: no row changes project.
CREATE TRIGGER "GoogleIntegrationConfig_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GoogleIntegrationConfig" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
