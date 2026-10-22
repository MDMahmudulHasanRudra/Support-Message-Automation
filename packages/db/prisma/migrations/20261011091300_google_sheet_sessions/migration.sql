-- Google Sheets work management, Phase 7 (GOOGLE_SHEETS.md §7): work time and viewing time.
-- Additive: one new enum, three new, empty, project-scoped tables, and a nullable column on the
-- activity log. Nothing existing changes.
--
-- A session is one person with one spreadsheet open in the app; its EVENTS (signals stamped with the
-- server's clock) are the record. Time is computed from them at read time by one pure function
-- (packages/shared `computeSheetTime`) and never stored as a second number.

-- CreateEnum
CREATE TYPE "GoogleSheetSessionEventKind" AS ENUM ('START', 'VIEW_SIGNAL', 'WORK_SIGNAL', 'CLOSE');

-- CreateTable
CREATE TABLE "GoogleSheetWorkSession" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "spreadsheetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamMemberId" TEXT,
    "memberRole" "GoogleSheetMemberRole",
    "canWork" BOOLEAN NOT NULL DEFAULT false,
    "clientKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSignalAt" TIMESTAMP(3) NOT NULL,
    "lastWorkAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "GoogleSheetWorkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleSheetWorkSessionEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "sessionId" TEXT NOT NULL,
    "kind" "GoogleSheetSessionEventKind" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleSheetWorkSessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: the per-project singleton. An absent row means the defaults.
CREATE TABLE "GoogleSheetsSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "inactivityMinutes" INTEGER NOT NULL DEFAULT 5,
    "updatedByUsername" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleSheetsSettings_pkey" PRIMARY KEY ("id")
);

-- AlterTable: the session an application activity happened in.
ALTER TABLE "GoogleSheetActivity" ADD COLUMN "sessionId" TEXT;

-- CreateIndex
CREATE INDEX "GoogleSheetWorkSession_projectId_spreadsheetId_lastSignalAt_idx" ON "GoogleSheetWorkSession"("projectId", "spreadsheetId", "lastSignalAt");

-- CreateIndex
CREATE INDEX "GoogleSheetWorkSession_projectId_userId_lastSignalAt_idx" ON "GoogleSheetWorkSession"("projectId", "userId", "lastSignalAt");

-- A repeated signal from the same open page never opens a second session.
CREATE UNIQUE INDEX "GoogleSheetWorkSession_projectId_clientKey_key" ON "GoogleSheetWorkSession"("projectId", "clientKey");

-- CreateIndex
CREATE INDEX "GoogleSheetWorkSessionEvent_projectId_sessionId_at_idx" ON "GoogleSheetWorkSessionEvent"("projectId", "sessionId", "at");

-- CreateIndex
CREATE INDEX "GoogleSheetWorkSessionEvent_projectId_at_idx" ON "GoogleSheetWorkSessionEvent"("projectId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleSheetsSettings_projectId_key" ON "GoogleSheetsSettings"("projectId");

-- AddForeignKey
ALTER TABLE "GoogleSheetWorkSession" ADD CONSTRAINT "GoogleSheetWorkSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetWorkSession" ADD CONSTRAINT "GoogleSheetWorkSession_spreadsheetId_fkey" FOREIGN KEY ("spreadsheetId") REFERENCES "GoogleSpreadsheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetWorkSession" ADD CONSTRAINT "GoogleSheetWorkSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetWorkSession" ADD CONSTRAINT "GoogleSheetWorkSession_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetWorkSessionEvent" ADD CONSTRAINT "GoogleSheetWorkSessionEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetWorkSessionEvent" ADD CONSTRAINT "GoogleSheetWorkSessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GoogleSheetWorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetsSettings" ADD CONSTRAINT "GoogleSheetsSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSheetActivity" ADD CONSTRAINT "GoogleSheetActivity_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GoogleSheetWorkSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 7 integrity: no row changes project, and every project-owned row it points at is in its own
-- project.
CREATE TRIGGER "GoogleSheetWorkSession_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GoogleSheetWorkSession" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "GoogleSheetWorkSession_spreadsheetId_same_project" AFTER INSERT OR UPDATE OF "spreadsheetId", "projectId" ON "GoogleSheetWorkSession" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('GoogleSpreadsheet', 'spreadsheetId');
CREATE CONSTRAINT TRIGGER "GoogleSheetWorkSession_teamMemberId_same_project" AFTER INSERT OR UPDATE OF "teamMemberId", "projectId" ON "GoogleSheetWorkSession" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('InternalTeamMember', 'teamMemberId');
CREATE TRIGGER "GoogleSheetWorkSessionEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GoogleSheetWorkSessionEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "GoogleSheetWorkSessionEvent_sessionId_same_project" AFTER INSERT OR UPDATE OF "sessionId", "projectId" ON "GoogleSheetWorkSessionEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('GoogleSheetWorkSession', 'sessionId');
CREATE TRIGGER "GoogleSheetsSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GoogleSheetsSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "GoogleSheetActivity_sessionId_same_project" AFTER INSERT OR UPDATE OF "sessionId", "projectId" ON "GoogleSheetActivity" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('GoogleSheetWorkSession', 'sessionId');
