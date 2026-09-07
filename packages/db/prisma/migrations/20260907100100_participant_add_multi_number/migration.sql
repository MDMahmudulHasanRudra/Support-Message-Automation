-- One job now adds several numbers across several groups: the unit of work becomes
-- (number x group), so the number moves onto the item and the job carries the list.
--
-- Every step is backfilled from existing data before anything is dropped, so historical jobs keep
-- reading exactly as they did.

-- 1. The job's list of numbers, seeded from the single number it used to carry.
ALTER TABLE "GroupParticipantAddJob" ADD COLUMN "phoneNumbers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "GroupParticipantAddJob" SET "phoneNumbers" = ARRAY["phoneNumber"] WHERE "phoneNumber" <> '';

-- 2. The item's own number. Added nullable, backfilled from its parent job, then made required —
--    a plain NOT NULL column would fail against any existing row.
ALTER TABLE "GroupParticipantAddItem" ADD COLUMN "phoneNumber" TEXT;
UPDATE "GroupParticipantAddItem" i
   SET "phoneNumber" = j."phoneNumber"
  FROM "GroupParticipantAddJob" j
 WHERE i."jobId" = j."id";
-- Any orphan (no parent job) could not exist — the FK is ON DELETE CASCADE — but a defaulted
-- empty string is still cheaper than a failed migration on a database nobody can inspect.
UPDATE "GroupParticipantAddItem" SET "phoneNumber" = '' WHERE "phoneNumber" IS NULL;
ALTER TABLE "GroupParticipantAddItem" ALTER COLUMN "phoneNumber" SET NOT NULL;

-- 3. Idempotency now has to include the number: the same group legitimately appears once per
--    person in the same job.
DROP INDEX IF EXISTS "GroupParticipantAddItem_jobId_groupId_key";
CREATE UNIQUE INDEX "GroupParticipantAddItem_jobId_groupId_phoneNumber_key"
    ON "GroupParticipantAddItem"("jobId", "groupId", "phoneNumber");

-- 4. The job's single number is now fully represented by phoneNumbers and by each item.
ALTER TABLE "GroupParticipantAddJob" DROP COLUMN "phoneNumber";

-- 5. The per-job size cap existed to bound the sending rate, but the rate limit it was protecting
--    is per-job too — so it forced twenty concurrent jobs to move 2,000 groups and multiplied the
--    real rate by twenty. The rate limit becomes global in the worker; this ceiling now bounds a
--    single mistake instead, and a big job simply takes longer.
ALTER TABLE "GroupParticipantAddSettings" ALTER COLUMN "maxPerJob" SET DEFAULT 2000;
UPDATE "GroupParticipantAddSettings" SET "maxPerJob" = 2000 WHERE "maxPerJob" = 100;
