-- Release Notes — a permanent, publishable record of what shipped.
--
-- Entirely additive: two new enums, two new tables, and two new nullable back-relations on User.
-- Nothing existing is dropped, renamed or rewritten.
--
-- The shape to understand before changing any of it: DRAFT is authoring, PUBLISHED and ARCHIVED are
-- BOTH publicly visible (archiving retires a release from being the *current* one, it does not
-- erase that it happened — "every release should remain available historically"). Content is seven
-- plain TEXT[] sections rather than one markdown body, because this app has no markdown renderer or
-- rich-text editor anywhere, and TEXT[] is already this schema's established way to store a short
-- list of lines. Editing a PUBLISHED/ARCHIVED row, or publishing one, writes an after-image
-- snapshot into ReleaseNoteRevision (modelled on AiKnowledgeVersion — "currentVersion" tracks the
-- same way); a PUBLISHED or ARCHIVED row can never be hard-deleted — only a DRAFT can, and
-- application code is what enforces that, matching this app's existing soft-delete-over-hard-delete
-- standard.
--
-- Both enums are CREATE TYPE, never ALTER TYPE ADD VALUE, so this needs no companion migration.

CREATE TYPE "ReleaseNoteType" AS ENUM ('MAJOR', 'FEATURE', 'IMPROVEMENT', 'BUG_FIX', 'SECURITY', 'MAINTENANCE');

CREATE TYPE "ReleaseNoteStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

CREATE TABLE "ReleaseNote" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "releaseDate" DATE NOT NULL,
    "releaseType" "ReleaseNoteType" NOT NULL DEFAULT 'FEATURE',
    "status" "ReleaseNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "whatsNew" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "improvements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bugFixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "security" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "breakingChanges" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "knownIssues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "technicalNotes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "affectedModules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" TEXT,
    "publishedByUserId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReleaseNoteRevision" (
    "id" TEXT NOT NULL,
    "releaseNoteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "releaseDate" DATE NOT NULL,
    "releaseType" "ReleaseNoteType" NOT NULL,
    "status" "ReleaseNoteStatus" NOT NULL,
    "whatsNew" TEXT[],
    "improvements" TEXT[],
    "bugFixes" TEXT[],
    "security" TEXT[],
    "breakingChanges" TEXT[],
    "knownIssues" TEXT[],
    "technicalNotes" TEXT[],
    "affectedModules" TEXT[],
    "changedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseNoteRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReleaseNote_version_key" ON "ReleaseNote"("version");

-- Serves the admin list, which is almost always filtered to one status and sorted newest-first.
CREATE INDEX "ReleaseNote_status_releaseDate_idx" ON "ReleaseNote"("status", "releaseDate");

-- Serves the public feed, which reads PUBLISHED *and* ARCHIVED together (an IN-list, not an
-- equality match the composite index above serves as well) sorted newest-first.
CREATE INDEX "ReleaseNote_releaseDate_idx" ON "ReleaseNote"("releaseDate");

CREATE UNIQUE INDEX "ReleaseNoteRevision_releaseNoteId_version_key" ON "ReleaseNoteRevision"("releaseNoteId", "version");

ALTER TABLE "ReleaseNote" ADD CONSTRAINT "ReleaseNote_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReleaseNote" ADD CONSTRAINT "ReleaseNote_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReleaseNoteRevision" ADD CONSTRAINT "ReleaseNoteRevision_releaseNoteId_fkey" FOREIGN KEY ("releaseNoteId") REFERENCES "ReleaseNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReleaseNoteRevision" ADD CONSTRAINT "ReleaseNoteRevision_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
