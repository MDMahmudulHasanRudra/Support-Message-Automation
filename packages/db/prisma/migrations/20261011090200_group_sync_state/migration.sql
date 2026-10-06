-- Group sync state per WhatsApp account (GROUP_SYNC.md).
--
-- Named 20261011090200 to sort directly after 20261011090100_mood_detection: this branch's chain
-- already runs ahead of the calendar (20261007…20261011, all pushed), and Prisma applies migrations
-- in name order, so a name dated today would sort before seven migrations that already exist.
--
-- Additive: one enum and nullable columns on WhatsAppAccount, so no row is rewritten and nothing is
-- backfilled — null means "never synced since this existed", and the next sync fills it in.

-- CreateEnum
CREATE TYPE "GroupSyncStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "WhatsAppAccount"
  ADD COLUMN "groupSyncStatus" "GroupSyncStatus",
  ADD COLUMN "groupSyncStage" TEXT,
  ADD COLUMN "groupSyncStartedAt" TIMESTAMP(3),
  ADD COLUMN "groupSyncCompletedAt" TIMESTAMP(3),
  ADD COLUMN "groupSyncDiscovered" INTEGER,
  ADD COLUMN "groupSyncNew" INTEGER,
  ADD COLUMN "groupSyncUpdated" INTEGER,
  ADD COLUMN "groupSyncDeactivated" INTEGER,
  ADD COLUMN "groupSyncFailed" INTEGER,
  ADD COLUMN "groupSyncDurationMs" INTEGER,
  ADD COLUMN "groupSyncError" TEXT;
