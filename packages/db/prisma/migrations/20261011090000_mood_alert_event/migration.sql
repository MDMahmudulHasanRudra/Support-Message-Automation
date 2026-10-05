-- One statement, alone in its own migration, because Postgres cannot use a new enum value in the
-- same transaction that adds it. Same shape as 20260918100000_collection_broken_event.
--
-- Mood Detection's alerts go through enqueueNotification like every other alert, so the
-- Notification Center's routing, muting and personal opt-in apply to them unchanged. That needs
-- its own event: "a customer is angry" is not an AI handover and not an SLA escalation, and a team
-- must be able to mute or route it on its own.

-- AlterEnum
ALTER TYPE "NotificationEvent" ADD VALUE 'MOOD_ALERT';
