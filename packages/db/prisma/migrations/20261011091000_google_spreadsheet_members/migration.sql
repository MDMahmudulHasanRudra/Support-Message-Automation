-- Google Sheets work management, Phase 5 (GOOGLE_SHEETS.md §5): sheet members.
-- Additive: two new enums and one new, empty, project-scoped table. Nothing existing changes.
-- The app's own record of who works on (LEAD / EDITOR) or monitors (MONITOR) a spreadsheet — kept
-- apart from Google Drive's sharing, and kept as HISTORY: one row per period, never overwritten.

-- CreateEnum
CREATE TYPE "GoogleSheetMemberRole" AS ENUM ('LEAD', 'EDITOR', 'MONITOR');

-- CreateEnum
CREATE TYPE "GoogleSheetMemberEndReason" AS ENUM ('ROLE_CHANGED', 'REMOVED');

-- CreateTable
CREATE TABLE "GoogleSpreadsheetMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "spreadsheetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "GoogleSheetMemberRole" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" "GoogleSheetMemberEndReason",
    "addedById" TEXT,
    "endedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleSpreadsheetMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleSpreadsheetMember_projectId_spreadsheetId_endedAt_idx" ON "GoogleSpreadsheetMember"("projectId", "spreadsheetId", "endedAt");

-- CreateIndex
CREATE INDEX "GoogleSpreadsheetMember_projectId_userId_endedAt_idx" ON "GoogleSpreadsheetMember"("projectId", "userId", "endedAt");

-- One OPEN period per person per sheet: two concurrent "add" presses cannot make two memberships.
-- Partial, so Prisma's schema cannot express it; closed periods (history) are unlimited.
CREATE UNIQUE INDEX "GoogleSpreadsheetMember_one_open_per_user" ON "GoogleSpreadsheetMember"("spreadsheetId", "userId") WHERE "endedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "GoogleSpreadsheetMember" ADD CONSTRAINT "GoogleSpreadsheetMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSpreadsheetMember" ADD CONSTRAINT "GoogleSpreadsheetMember_spreadsheetId_fkey" FOREIGN KEY ("spreadsheetId") REFERENCES "GoogleSpreadsheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSpreadsheetMember" ADD CONSTRAINT "GoogleSpreadsheetMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSpreadsheetMember" ADD CONSTRAINT "GoogleSpreadsheetMember_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSpreadsheetMember" ADD CONSTRAINT "GoogleSpreadsheetMember_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 7 integrity: no row changes project, and a member row's sheet is in its own project. (The
-- three User columns point at platform users, which have no project.)
CREATE TRIGGER "GoogleSpreadsheetMember_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GoogleSpreadsheetMember" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "GoogleSpreadsheetMember_spreadsheetId_same_project" AFTER INSERT OR UPDATE OF "spreadsheetId", "projectId" ON "GoogleSpreadsheetMember" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('GoogleSpreadsheet', 'spreadsheetId');
