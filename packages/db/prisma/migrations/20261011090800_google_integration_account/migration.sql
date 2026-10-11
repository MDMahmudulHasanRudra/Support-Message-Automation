-- Google Sheets work management, Phase 1 (GOOGLE_SHEETS.md): connected Google accounts.
-- Additive: one new, empty, project-scoped table and its status enum. Nothing existing changes.
-- OAuth tokens are stored only as encryptSecret envelopes (AES-256-GCM with a key id, the same
-- scheme as AI provider keys). Disconnecting wipes them and keeps the row for history.

-- CreateEnum
CREATE TYPE "GoogleAccountStatus" AS ENUM ('CONNECTED', 'NEEDS_RECONNECT', 'DISCONNECTED');

-- CreateTable
CREATE TABLE "GoogleIntegrationAccount" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "googleSubject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "pictureUrl" TEXT,
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "GoogleAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "refreshTokenCiphertext" TEXT,
    "accessTokenCiphertext" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "spreadsheetCount" INTEGER,
    "spreadsheetsCountedAt" TIMESTAMP(3),
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "disconnectedByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleIntegrationAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleIntegrationAccount_projectId_googleSubject_key" ON "GoogleIntegrationAccount"("projectId", "googleSubject");

-- CreateIndex
CREATE INDEX "GoogleIntegrationAccount_projectId_status_idx" ON "GoogleIntegrationAccount"("projectId", "status");

-- AddForeignKey
ALTER TABLE "GoogleIntegrationAccount" ADD CONSTRAINT "GoogleIntegrationAccount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleIntegrationAccount" ADD CONSTRAINT "GoogleIntegrationAccount_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 7 integrity: no row changes project. (connectedById points at a platform User, which has no
-- project, so it needs no same-project trigger.)
CREATE TRIGGER "GoogleIntegrationAccount_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GoogleIntegrationAccount" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
