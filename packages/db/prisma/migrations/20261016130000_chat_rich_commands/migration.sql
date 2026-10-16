-- Chat v2 rich messaging (CHAT_RICH_MESSAGING.md): four new worker commands. Alone in their own
-- migration, because Postgres cannot use a new enum value in the same transaction that adds it.
-- Same shape as 20261011090000_mood_alert_event. Additive: nothing existing reads these values, and
-- an old worker that claims one closes it FAILED as an unknown command type.

-- AlterEnum
ALTER TYPE "WorkerCommandType" ADD VALUE 'LOAD_EARLIER_MESSAGES';
ALTER TYPE "WorkerCommandType" ADD VALUE 'STAR_MESSAGE';
ALTER TYPE "WorkerCommandType" ADD VALUE 'PIN_CHAT';
ALTER TYPE "WorkerCommandType" ADD VALUE 'ARCHIVE_CHAT';
