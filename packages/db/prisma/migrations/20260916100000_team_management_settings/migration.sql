-- Grace periods for Duty History's scheduled-against-observed comparison.
--
-- The comparison itself needs no setting: each DutyAssignment already snapshots the shift name and
-- times, and TeamAttendanceDay already stores firstActivityAt/lastActivityAt on every message. The
-- arithmetic between them is exact. What needs a setting is the POLICY laid over it -- how far past
-- the scheduled start a first message may fall before anyone calls it a late start.
--
-- It lives in a table rather than a constant because this module's design rule is that a business
-- rule is never hardcoded. The three shift templates ship as seed rows for the same reason: so that
-- 10:00-19:00 is a decision somebody made and can change, not a number compiled into the source.
--
-- Two columns rather than one. Arriving late and leaving early are judged differently by most
-- teams, and a single shared tolerance would force one of the two readings to be wrong. Both
-- default to 15 minutes, which is a starting point an admin is expected to change, not a claim
-- about this organisation.
--
-- Additive, and inert until somebody opens the settings page: the singleton row is created on
-- first read by an upsert, exactly as every other settings row in this schema is, so no seed and
-- no backfill is required and an unmigrated deployment is not left in a half-configured state.
CREATE TABLE "TeamManagementSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "latenessGraceMinutes" INTEGER NOT NULL DEFAULT 15,
    "earlyDepartureGraceMinutes" INTEGER NOT NULL DEFAULT 15,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamManagementSettings_pkey" PRIMARY KEY ("id")
);
