-- One statement, alone in its own migration, because Postgres cannot use a new enum value in the
-- same transaction that adds it — a later migration touching NotificationEvent would fail. Same
-- shape as 20260811155507_add_logout_command.
--
-- Until now NotificationEvent held only the five reasons the worker raises an alert ABOUT A
-- CONVERSATION. Nothing in the vocabulary could describe the system itself being broken, so the
-- 18 Sep 2026 collection outage had no way to reach anybody: not a missing call site, a missing
-- word. This is that word.

-- AlterEnum
ALTER TYPE "NotificationEvent" ADD VALUE 'COLLECTION_BROKEN';
