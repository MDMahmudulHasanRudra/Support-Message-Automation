-- Google Sheets work management, Phase 2 (GOOGLE_SHEETS.md): the spreadsheet list.
-- Additive: two new, empty, project-scoped tables. Nothing existing changes.
-- METADATA ONLY — names, dates, links, owners and what Google lets each connected account do.
-- Nothing from inside a spreadsheet is stored. Rows are never deleted: a file no connected account
-- can see any more gets "removedAt", so history recorded against it keeps its meaning.

-- CreateTable
CREATE TABLE "GoogleSpreadsheet" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "googleFileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "webViewLink" TEXT,
    "modifiedTime" TIMESTAMP(3),
    "ownerEmail" TEXT,
    "ownerName" TEXT,
    "lastModifiedByName" TEXT,
    "lastModifiedByEmail" TEXT,
    "sharedInGoogle" BOOLEAN NOT NULL DEFAULT false,
    "isMonitored" BOOLEAN NOT NULL DEFAULT false,
    "monitoredAt" TIMESTAMP(3),
    "monitoredByUsername" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleSpreadsheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleSpreadsheetAccess" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "spreadsheetId" TEXT NOT NULL,
    "googleAccountId" TEXT NOT NULL,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "canShare" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "GoogleSpreadsheetAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleSpreadsheet_projectId_removedAt_modifiedTime_idx" ON "GoogleSpreadsheet"("projectId", "removedAt", "modifiedTime");

-- CreateIndex
CREATE INDEX "GoogleSpreadsheet_projectId_isMonitored_idx" ON "GoogleSpreadsheet"("projectId", "isMonitored");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleSpreadsheet_projectId_googleFileId_key" ON "GoogleSpreadsheet"("projectId", "googleFileId");

-- CreateIndex
CREATE INDEX "GoogleSpreadsheetAccess_projectId_googleAccountId_removedAt_idx" ON "GoogleSpreadsheetAccess"("projectId", "googleAccountId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleSpreadsheetAccess_spreadsheetId_googleAccountId_key" ON "GoogleSpreadsheetAccess"("spreadsheetId", "googleAccountId");

-- AddForeignKey
ALTER TABLE "GoogleSpreadsheet" ADD CONSTRAINT "GoogleSpreadsheet_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSpreadsheetAccess" ADD CONSTRAINT "GoogleSpreadsheetAccess_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSpreadsheetAccess" ADD CONSTRAINT "GoogleSpreadsheetAccess_spreadsheetId_fkey" FOREIGN KEY ("spreadsheetId") REFERENCES "GoogleSpreadsheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSpreadsheetAccess" ADD CONSTRAINT "GoogleSpreadsheetAccess_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "GoogleIntegrationAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 7 integrity: no row changes project, and an access row's sheet and account are in its own project.
CREATE TRIGGER "GoogleSpreadsheet_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GoogleSpreadsheet" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "GoogleSpreadsheetAccess_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GoogleSpreadsheetAccess" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "GoogleSpreadsheetAccess_spreadsheetId_same_project" AFTER INSERT OR UPDATE OF "spreadsheetId", "projectId" ON "GoogleSpreadsheetAccess" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('GoogleSpreadsheet', 'spreadsheetId');
CREATE CONSTRAINT TRIGGER "GoogleSpreadsheetAccess_googleAccountId_same_project" AFTER INSERT OR UPDATE OF "googleAccountId", "projectId" ON "GoogleSpreadsheetAccess" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('GoogleIntegrationAccount', 'googleAccountId');
