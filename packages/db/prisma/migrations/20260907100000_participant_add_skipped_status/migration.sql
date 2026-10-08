-- A number already in the group is neither ADDED nor FAILED: nothing changed and nothing went
-- wrong. Its own status so re-running a roster over every group reports honestly.
--
-- Alone in its own migration on purpose. Postgres refuses to USE a new enum value in the same
-- transaction that added it, and Prisma runs one migration per transaction — the next migration
-- backfills data, so keeping these apart leaves room for that to reference this value later.
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_ALREADY_MEMBER';
