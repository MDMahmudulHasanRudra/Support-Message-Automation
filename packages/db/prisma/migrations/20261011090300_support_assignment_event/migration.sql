-- One statement, alone in its own migration, because Postgres cannot use a new enum value in the
-- same transaction that adds it. Same shape as 20261011090000_mood_alert_event.
-- AlterEnum
ALTER TYPE "NotificationEvent" ADD VALUE 'SUPPORT_ASSIGNMENT';
