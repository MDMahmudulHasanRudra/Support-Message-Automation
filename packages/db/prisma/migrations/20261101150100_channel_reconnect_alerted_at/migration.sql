-- Meta expansion A3: when the worker last announced that this connection needs reconnecting. Set when the
-- alert is queued (conditionally, so it is raised once), cleared when the connection is no longer
-- NEEDS_RECONNECT, so the next time it breaks is announced again. Nullable, no default: existing rows read
-- as "not announced", and the first sweep announces a connection already waiting for a reconnect.
-- Pre-use rollback: ALTER TABLE "ChannelConnection" DROP COLUMN "reconnectAlertedAt";
ALTER TABLE "ChannelConnection" ADD COLUMN "reconnectAlertedAt" TIMESTAMP(3);
