-- Removes WorkerCommandType.GET_QR, a command that was never once issued.
--
-- `git log -S` finds no commit in this repository's history where apps/web contained the string
-- "GET_QR", and none where anything called enqueueCommand("GET_QR"). It entered the enum with the
-- initial schema, was given a handler by the Phase 5 command poller, and never got a caller. Two
-- recovery guards (accountRegistrySync.recoverIfDropped, collectionWatchdog.operatorIsHandlingIt)
-- then listed it among the commands meaning "an operator is already dealing with this account" —
-- defending against a row nothing could create.
--
-- It could not have done the job its name implies in any case. @open-wa/wa-automate exposes no
-- on-demand QR call at all (no getQr, no requestQr, no forceRefreshQr): a QR exists only because
-- create() emitted one on ev.on('qr.**'), so the only way to obtain a fresh code is to begin a
-- connection attempt — which is what RECONNECT does. The handler read WhatsAppAccount.qrCode and
-- returned it, a column the dashboard already reads directly on its own 3–5s poll.
--
-- Nothing about the QR lifecycle changes here: the provider's qr.** listener, qrCode/qrUpdatedAt,
-- the boot-time QR clear, RECONNECT, automatic drop recovery, staleness and phone/link-code
-- pairing are all untouched.

-- Defensive, and deliberately so: the type swap below cannot cast a value that is about to stop
-- existing, and this runs against a live database whose full history no audit here can read. The
-- analysis above says this affects zero rows; the DELETE costs nothing if that is right and saves
-- the deployment if a row was ever inserted by hand. Deleting rather than remapping is the honest
-- option — GET_QR is not a weaker RECONNECT, it performed no action, and rewriting it as some
-- other command would invent an operation that never happened.
DELETE FROM "WorkerCommand" WHERE "type" = 'GET_QR';

-- AlterEnum
-- WorkerCommand.type has no DB default, so unlike the WhatsAppAccountStatus swap this needs no
-- DROP DEFAULT / SET DEFAULT pair around it.
BEGIN;
CREATE TYPE "WorkerCommandType_new" AS ENUM ('RECONNECT', 'SEND_LIVE_TEST', 'RESYNC_GROUPS', 'GET_GROUP_PARTICIPANT_COUNT', 'LOGOUT', 'AI_ANALYSIS_BATCH', 'TEAMS_SYNC_NOW', 'FORGE_SYNC_NOW', 'BUILD_COMMUNICATION_STYLE', 'GET_GROUP_PARTICIPANTS', 'BUILD_GROUP_KNOWLEDGE', 'REACT_TO_MESSAGE', 'EDIT_MESSAGE', 'CREATE_GROUP', 'JOIN_GROUP', 'UPDATE_PROFILE');
ALTER TABLE "WorkerCommand" ALTER COLUMN "type" TYPE "WorkerCommandType_new" USING ("type"::text::"WorkerCommandType_new");
ALTER TYPE "WorkerCommandType" RENAME TO "WorkerCommandType_old";
ALTER TYPE "WorkerCommandType_new" RENAME TO "WorkerCommandType";
DROP TYPE "WorkerCommandType_old";
COMMIT;
