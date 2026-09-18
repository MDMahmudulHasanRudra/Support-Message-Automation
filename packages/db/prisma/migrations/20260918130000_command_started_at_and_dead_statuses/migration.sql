-- Two recovery-robustness changes.
--
-- 1. WorkerCommand.startedAt — so stuck-command recovery can tell a command that has been running
--    for eleven minutes from one that died with its process.
--
--    recoverStuckCommands had NO age cutoff, justified in its own comment by "this runs once at
--    boot". That stopped being true when it began running every five minutes, and it then started
--    marking commands FAILED while they were still running: a RECONNECT waiting up to ten minutes
--    for a QR scan, or an eight-minute RESYNC_GROUPS, reported to the operator as "the worker
--    restarted while this was running, run it again" — so they did, on top of the one still going.
--
--    Existing PROCESSING rows get a NULL startedAt, which the recovery code reads as "claimed by a
--    process that is gone" and releases at the next boot. That is the correct reading: this
--    migration deploys with a restart, so nothing claimed before it can still be running.
--
-- 2. Removing two WhatsAppAccountStatus values that nothing has ever written.
--
--    OUTBOUND_PAUSED and RATE_LIMITED were rendered on the Accounts page as real states, with
--    their own colours and hints describing a per-account throttling mechanism that does not
--    exist. Throttling in this system is per outbound MESSAGE — OutboundMessageStatus.RATE_LIMITED,
--    which is real and untouched by this migration.
--
--    The UPDATE below is defensive rather than expected: `grep` finds no writer, and
--    reconcileAccountStatusesOnBoot has been normalising both to DISCONNECTED on every boot since
--    it was written. It costs nothing and makes the type swap unable to fail on a surprise row.

-- AlterTable
ALTER TABLE "WorkerCommand" ADD COLUMN "startedAt" TIMESTAMP(3);

-- Belt and braces: the type swap below cannot cast a value that is about to stop existing.
UPDATE "WhatsAppAccount" SET "status" = 'DISCONNECTED' WHERE "status" IN ('OUTBOUND_PAUSED', 'RATE_LIMITED');

-- AlterEnum
BEGIN;
CREATE TYPE "WhatsAppAccountStatus_new" AS ENUM ('CONNECTED', 'DISCONNECTED', 'RECONNECTING', 'AUTHENTICATION_REQUIRED', 'SESSION_ERROR', 'ERROR');
ALTER TABLE "WhatsAppAccount" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "WhatsAppAccount" ALTER COLUMN "status" TYPE "WhatsAppAccountStatus_new" USING ("status"::text::"WhatsAppAccountStatus_new");
ALTER TYPE "WhatsAppAccountStatus" RENAME TO "WhatsAppAccountStatus_old";
ALTER TYPE "WhatsAppAccountStatus_new" RENAME TO "WhatsAppAccountStatus";
DROP TYPE "WhatsAppAccountStatus_old";
ALTER TABLE "WhatsAppAccount" ALTER COLUMN "status" SET DEFAULT 'DISCONNECTED';
COMMIT;
