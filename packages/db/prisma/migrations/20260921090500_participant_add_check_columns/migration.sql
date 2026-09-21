-- The columns the check phase writes into. Separate from the migration before it only because
-- Postgres refuses to use a new enum value in the transaction that created it.
--
-- All three are nullable with no default and no backfill: every existing row predates the check
-- phase, and inventing a `checkedAt` for a job that was never checked would be a fact this system
-- does not have. An old job reads as "not checked", which is exactly what it is.

-- WhatsApp's own code for what happened, beside the prose rather than inside it. `failureReason`
-- is written for a person to read and has always been the only record, so "how many adds did
-- privacy settings block this week" was not answerable. Numeric codes come from
-- AddParticipantError (409 already in group, 403 privacy settings, 408 recently left, 500 group
-- full); string codes are WhatsApp's own (INSUFFICIENT_PERMISSIONS, NOT_A_CONTACT,
-- GROUP_DOES_NOT_EXIST, NOT_A_GROUP_CHAT).
ALTER TABLE "GroupParticipantAddItem" ADD COLUMN "failureCode" TEXT;

-- What the number actually resolved to, when the check could establish it. Without keeping what
-- was matched on, a later reader cannot tell a verified absence from an unverifiable one.
ALTER TABLE "GroupParticipantAddItem" ADD COLUMN "whatsappId" TEXT;

-- When this pair was last checked. A retry re-checks rather than re-attempts, so this is what
-- says whether the answer being acted on is still fresh.
ALTER TABLE "GroupParticipantAddItem" ADD COLUMN "checkedAt" TIMESTAMP(3);

-- The check loop claims by job, so one job's roster reads stay together: reading a group's roster
-- once serves every number in that job, and claims scattered across jobs would re-read it.
CREATE INDEX "GroupParticipantAddItem_jobId_status_idx" ON "GroupParticipantAddItem"("jobId", "status");
