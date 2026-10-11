-- Google Sheets work management, Phase 6 (GOOGLE_SHEETS.md §6): the activity log.
-- Additive: four new enums and one new, empty, project-scoped, APPEND-ONLY table. Nothing existing
-- changes. VIEW is kept apart from WORK, and APPLICATION (done in this app, exact) apart from
-- EXTERNAL_GOOGLE (done in Google, as far as Google says). No cell value and no search text is ever
-- stored — only what was done, where (tab, A1 range) and by whom.

-- CreateEnum
CREATE TYPE "GoogleSheetActivityKind" AS ENUM ('VIEW', 'WORK', 'OTHER');

-- CreateEnum
CREATE TYPE "GoogleSheetActivitySource" AS ENUM ('APPLICATION', 'EXTERNAL_GOOGLE');

-- CreateEnum
CREATE TYPE "GoogleSheetActionType" AS ENUM ('SPREADSHEET_OPENED', 'TAB_OPENED', 'REFRESHED', 'SEARCHED', 'CELLS_EDITED', 'ROWS_ADDED', 'ROWS_DELETED', 'COLUMNS_ADDED', 'COLUMNS_DELETED', 'EXTERNAL_EDIT', 'EXTERNAL_CREATE', 'EXTERNAL_RENAME', 'EXTERNAL_DELETE', 'EXTERNAL_RESTORE', 'EXTERNAL_COMMENT', 'EXTERNAL_PERMISSION_CHANGE', 'EXTERNAL_MOVE', 'EXTERNAL_OTHER');

-- CreateEnum
CREATE TYPE "GoogleSheetAttribution" AS ENUM ('APPLICATION', 'ATTRIBUTED', 'UNATTRIBUTED', 'APPLICATION_ECHO');

-- CreateTable
CREATE TABLE "GoogleSheetActivity" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "spreadsheetId" TEXT NOT NULL,
    "kind" "GoogleSheetActivityKind" NOT NULL,
    "source" "GoogleSheetActivitySource" NOT NULL,
    "actionType" "GoogleSheetActionType" NOT NULL,
    "attribution" "GoogleSheetAttribution" NOT NULL,
    "unattributedReason" TEXT,
    "tabId" INTEGER,
    "tabTitle" TEXT,
    "range" TEXT,
    "itemCount" INTEGER,
    "detail" TEXT,
    "userId" TEXT,
    "teamMemberId" TEXT,
    "memberRole" "GoogleSheetMemberRole",
    "googleAccountId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "externalKey" TEXT,
    "externalActorPersonId" TEXT,
    "externalActorKind" TEXT,
    "echoOfActivityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleSheetActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleSheetActivity_projectId_spreadsheetId_occurredAt_idx" ON "GoogleSheetActivity"("projectId", "spreadsheetId", "occurredAt");

-- CreateIndex
CREATE INDEX "GoogleSheetActivity_projectId_userId_occurredAt_idx" ON "GoogleSheetActivity"("projectId", "userId", "occurredAt");

-- CreateIndex
CREATE INDEX "GoogleSheetActivity_projectId_occurredAt_idx" ON "GoogleSheetActivity"("projectId", "occurredAt");

-- Reading the same period of Google's record twice never records a change twice. Application rows
-- carry no key (NULLs never collide).
CREATE UNIQUE INDEX "GoogleSheetActivity_projectId_externalKey_key" ON "GoogleSheetActivity"("projectId", "externalKey");

-- AddForeignKey
ALTER TABLE "GoogleSheetActivity" ADD CONSTRAINT "GoogleSheetActivity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetActivity" ADD CONSTRAINT "GoogleSheetActivity_spreadsheetId_fkey" FOREIGN KEY ("spreadsheetId") REFERENCES "GoogleSpreadsheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetActivity" ADD CONSTRAINT "GoogleSheetActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetActivity" ADD CONSTRAINT "GoogleSheetActivity_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetActivity" ADD CONSTRAINT "GoogleSheetActivity_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "GoogleIntegrationAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetActivity" ADD CONSTRAINT "GoogleSheetActivity_echoOfActivityId_fkey" FOREIGN KEY ("echoOfActivityId") REFERENCES "GoogleSheetActivity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 7 integrity: no row changes project, and every project-owned row it points at is in its own
-- project. (The user column points at platform users, which have no project.)
CREATE TRIGGER "GoogleSheetActivity_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GoogleSheetActivity" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "GoogleSheetActivity_spreadsheetId_same_project" AFTER INSERT OR UPDATE OF "spreadsheetId", "projectId" ON "GoogleSheetActivity" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('GoogleSpreadsheet', 'spreadsheetId');
CREATE CONSTRAINT TRIGGER "GoogleSheetActivity_teamMemberId_same_project" AFTER INSERT OR UPDATE OF "teamMemberId", "projectId" ON "GoogleSheetActivity" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'teamMemberId');
CREATE CONSTRAINT TRIGGER "GoogleSheetActivity_googleAccountId_same_project" AFTER INSERT OR UPDATE OF "googleAccountId", "projectId" ON "GoogleSheetActivity" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('GoogleIntegrationAccount', 'googleAccountId');
CREATE CONSTRAINT TRIGGER "GoogleSheetActivity_echoOfActivityId_same_project" AFTER INSERT OR UPDATE OF "echoOfActivityId", "projectId" ON "GoogleSheetActivity" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('GoogleSheetActivity', 'echoOfActivityId');
