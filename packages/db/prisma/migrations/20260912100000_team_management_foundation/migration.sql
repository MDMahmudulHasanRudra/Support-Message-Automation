-- Team Management / Workforce Operations — the foundation.
--
-- Entirely additive: nine new tables, five new enums, one nullable column on InternalTeamMember and
-- one index on Message. Nothing existing is dropped, renamed or rewritten, so this is safe against
-- live data and reversible in design.
--
-- The shape to understand before changing any of it: three records that are never collapsed into
-- one. DutyAssignment is what was PLANNED, TeamAttendanceDay is what actually HAPPENED, and
-- LeaveRequest is what was APPROVED. "Off-day duty", "no activity" and "on leave but active" are
-- all DERIVED by joining those three at read time. There is deliberately no stored "actual status"
-- column, because a stored derivation drifts from its own inputs the moment one of them is
-- corrected, and then two screens disagree about the same day with nothing to say which is right.
--
-- Every enum here is CREATE TYPE, never ALTER TYPE ADD VALUE, so this needs no companion migration
-- (Postgres refuses to USE a new enum value in the transaction that added it, and Prisma runs one
-- migration per transaction).

CREATE TYPE "DutyStatus" AS ENUM ('DUTY', 'OFF', 'LEAVE', 'HOLIDAY', 'COVERAGE', 'EXTRA_DUTY', 'UNASSIGNED');

CREATE TYPE "DutyAssignmentSource" AS ENUM ('WEEKLY_SCHEDULE', 'MANUAL', 'COVERAGE', 'LEAVE', 'HOLIDAY', 'SHIFT_CHANGE');

CREATE TYPE "LeaveStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TYPE "AttendanceSource" AS ENUM ('WHATSAPP_ACTIVITY', 'MANUAL');

-- ABSENT is in this enum and nowhere else on purpose: it is a manager's verdict, never a
-- conclusion the system draws. Silence is not evidence of absence — somebody on the phone all day,
-- or working in a group this account cannot see, produces no messages and has still worked.
CREATE TYPE "AttendanceOverride" AS ENUM ('WORKED', 'ABSENT', 'EXCUSED');

-- Shift times are minutes from LOCAL midnight rather than a timestamp or a "13:00" string: that
-- makes them timezone-free, sortable, comparable for overlap, and able to cross midnight without a
-- second column saying so (endMinute <= startMinute means it ends the next day).
--
-- The rows this ships with (Morning 10:00-19:00, Mid 12:00-21:00, Late 13:00-22:00) are SEED DATA.
-- Nothing may branch on a shift's name or on those hours — an operator has to be able to add a
-- night shift or a 09:00-18:00 from the UI without a code change.
CREATE TABLE "ShiftTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "requiredHeadcount" INTEGER NOT NULL DEFAULT 1,
    "colourSlot" INTEGER,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShiftTemplate_name_key" ON "ShiftTemplate"("name");
CREATE INDEX "ShiftTemplate_isActive_position_idx" ON "ShiftTemplate"("isActive", "position");

-- One member's recurring pattern for one weekday, 0=Sunday..6=Saturday to match getDhakaWeekRange's
-- Sunday start.
--
-- The ABSENCE of a row means "nobody has decided yet"; a row with a null shiftTemplateId means
-- "decided: off that day". Collapsing those would make an unfilled rota look fully scheduled, which
-- is the most dangerous thing a rota can do.
CREATE TABLE "WeeklyScheduleEntry" (
    "id" TEXT NOT NULL,
    "teamMemberId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "shiftTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyScheduleEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WeeklyScheduleEntry_teamMemberId_weekday_key" ON "WeeklyScheduleEntry"("teamMemberId", "weekday");
CREATE INDEX "WeeklyScheduleEntry_shiftTemplateId_idx" ON "WeeklyScheduleEntry"("shiftTemplateId");

-- What one person is actually doing on one specific date. THE AUTHORITY for that date.
--
-- shiftName/shiftStartMinute/shiftEndMinute are snapshotted alongside the template FK so history
-- survives a template edit: changing what "Late" means from now on must not rewrite what somebody
-- worked last Tuesday. Same reasoning as SupportPriorityPolicy snapshotting SLA minutes onto a case.
--
-- The (teamMemberId, dutyDate) unique constraint is how "one person cannot hold two overlapping
-- shifts" is enforced in the database rather than by an application check somebody can forget. It
-- is also load-bearing for the coverage flow: a replacement candidate who already holds that date
-- cannot be given a second row, so the workflow must surface the clash instead of silently
-- overwriting their shift or moving a third person to make room.
CREATE TABLE "DutyAssignment" (
    "id" TEXT NOT NULL,
    "teamMemberId" TEXT NOT NULL,
    "dutyDate" DATE NOT NULL,
    "status" "DutyStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "shiftTemplateId" TEXT,
    "shiftName" TEXT,
    "shiftStartMinute" INTEGER,
    "shiftEndMinute" INTEGER,
    "source" "DutyAssignmentSource" NOT NULL DEFAULT 'MANUAL',
    "reason" TEXT,
    "assignedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DutyAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DutyAssignment_teamMemberId_dutyDate_key" ON "DutyAssignment"("teamMemberId", "dutyDate");
-- "Who is on today", the most-run query in the module.
CREATE INDEX "DutyAssignment_dutyDate_status_idx" ON "DutyAssignment"("dutyDate", "status");
-- Counting assigned headcount per shift per date, for the coverage-gap check.
CREATE INDEX "DutyAssignment_shiftTemplateId_dutyDate_idx" ON "DutyAssignment"("shiftTemplateId", "dutyDate");

-- Every meaningful roster change, kept forever — an immutable record rather than an edit in place,
-- so "Rakib moved from Late to Morning on the 12th, by Rudra, because of a staff shortage" survives
-- every later change to that date. Modelled on AiKnowledgeVersion.
--
-- changeGroupId is what makes a shift change readable afterwards: moving Rakib and putting Bipul on
-- the shift he vacated is ONE manager decision, and two unrelated rows would not say so.
CREATE TABLE "DutyAssignmentChange" (
    "id" TEXT NOT NULL,
    "teamMemberId" TEXT NOT NULL,
    "dutyDate" DATE NOT NULL,
    "previousStatus" "DutyStatus",
    "previousShiftName" TEXT,
    "newStatus" "DutyStatus" NOT NULL,
    "newShiftName" TEXT,
    "reason" TEXT,
    "changeGroupId" TEXT,
    "changedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DutyAssignmentChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DutyAssignmentChange_teamMemberId_dutyDate_idx" ON "DutyAssignmentChange"("teamMemberId", "dutyDate");
CREATE INDEX "DutyAssignmentChange_createdAt_idx" ON "DutyAssignmentChange"("createdAt");
CREATE INDEX "DutyAssignmentChange_changeGroupId_idx" ON "DutyAssignmentChange"("changeGroupId");

-- Leave types are entirely configurable. This schema states no legal policy of its own: entitlement
-- is a decision for the business and differs by country, so inventing one here would be a claim the
-- software is not entitled to make. A null annualAllowanceDays means "no allowance tracked", which
-- is different from an allowance of zero.
CREATE TABLE "LeaveType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "annualAllowanceDays" INTEGER,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeaveType_name_key" ON "LeaveType"("name");
CREATE INDEX "LeaveType_isActive_position_idx" ON "LeaveType"("isActive", "position");

-- requestedByUserId exists from this first migration even though employees cannot submit a request
-- yet. The manager-entered path and a future self-service path are the same record; adding the
-- column later would leave every existing row silently claiming the wrong person asked.
--
-- dayCount is counted once at creation so a holiday declared later cannot retroactively change the
-- size of an already-approved request.
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "teamMemberId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "dayCount" INTEGER NOT NULL,
    "reason" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedByUserId" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "managerNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeaveRequest_teamMemberId_startDate_idx" ON "LeaveRequest"("teamMemberId", "startDate");
-- Approved leave overlapping a date is subtracted from that date's effective coverage, and pending
-- requests are the manager's queue. Both filter on status plus a date range.
CREATE INDEX "LeaveRequest_status_startDate_idx" ON "LeaveRequest"("status", "startDate");

-- Organisation holidays. No national or religious calendar is assumed or hardcoded.
CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Holiday_date_key" ON "Holiday"("date");

-- Evidence that somebody worked on a given local day, derived from the messages they really sent.
-- Evidence, not a verdict: this records what was observed and never on its own declares anybody
-- present or absent. The override columns sit BESIDE the evidence rather than replacing it, so
-- "the manager says he worked, and there were no messages" stays readable as exactly that.
--
-- Counts are recomputed from Message on every hook run, never incremented — a replayed message, a
-- worker retry or a reconnect would each add one again. The recompute takes a transaction-scoped
-- advisory lock on (teamMemberId, activityDate) so two concurrent recomputes cannot interleave a
-- stale read over a fresh write. That lock lives in the database, not in worker memory: two worker
-- processes share no memory to lock in.
CREATE TABLE "TeamAttendanceDay" (
    "id" TEXT NOT NULL,
    "teamMemberId" TEXT NOT NULL,
    "activityDate" DATE NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueGroupCount" INTEGER NOT NULL DEFAULT 0,
    "firstActivityAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "source" "AttendanceSource" NOT NULL DEFAULT 'WHATSAPP_ACTIVITY',
    "override" "AttendanceOverride",
    "overrideReason" TEXT,
    "overriddenByUserId" TEXT,
    "overriddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamAttendanceDay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamAttendanceDay_teamMemberId_activityDate_key" ON "TeamAttendanceDay"("teamMemberId", "activityDate");
CREATE INDEX "TeamAttendanceDay_activityDate_idx" ON "TeamAttendanceDay"("activityDate");

-- Which groups a day's activity happened in, and how much in each. One row per group per day rather
-- than one per message: seven messages across two groups is two rows, not seven. The composite
-- primary key is the upsert target, so a recompute rewrites these in place instead of accumulating.
--
-- accountId is kept because the same WhatsApp group is a separate row per account and that
-- attribution has to survive — even though the attendance itself belongs to the person rather than
-- to whichever number happened to receive them.
CREATE TABLE "TeamAttendanceGroup" (
    "attendanceDayId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamAttendanceGroup_pkey" PRIMARY KEY ("attendanceDayId","groupId")
);

CREATE INDEX "TeamAttendanceGroup_groupId_idx" ON "TeamAttendanceGroup"("groupId");

-- The shift somebody normally works. Deliberately NOT authoritative for any date — DutyAssignment
-- is. One nullable column here rather than a separate profile table: a second table keyed on the
-- same person holding one field would be a second identity concept for no benefit.
ALTER TABLE "InternalTeamMember" ADD COLUMN "defaultShiftTemplateId" TEXT;

-- Team Management recomputes one member's attendance for one local day on every group message they
-- send: "this sender, between these two instants". The bare senderPhone index made that walk every
-- message that sender has ever sent and filter by date afterwards, which grows without limit as the
-- deployment ages; this stops at the day.
CREATE INDEX "Message_senderPhone_timestampWa_idx" ON "Message"("senderPhone", "timestampWa");

-- Foreign keys. Cascade where the child is meaningless without its parent (a roster row for a
-- deleted person), SetNull for "who did this" attribution so history survives a user being removed,
-- and Restrict where deleting the parent would silently destroy operational history — a shift
-- template or leave type in use must be DEACTIVATED, never deleted, per the project's
-- soft-delete-over-hard-delete rule.
ALTER TABLE "InternalTeamMember" ADD CONSTRAINT "InternalTeamMember_defaultShiftTemplateId_fkey" FOREIGN KEY ("defaultShiftTemplateId") REFERENCES "ShiftTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WeeklyScheduleEntry" ADD CONSTRAINT "WeeklyScheduleEntry_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WeeklyScheduleEntry" ADD CONSTRAINT "WeeklyScheduleEntry_shiftTemplateId_fkey" FOREIGN KEY ("shiftTemplateId") REFERENCES "ShiftTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DutyAssignment" ADD CONSTRAINT "DutyAssignment_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DutyAssignment" ADD CONSTRAINT "DutyAssignment_shiftTemplateId_fkey" FOREIGN KEY ("shiftTemplateId") REFERENCES "ShiftTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DutyAssignment" ADD CONSTRAINT "DutyAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DutyAssignmentChange" ADD CONSTRAINT "DutyAssignmentChange_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DutyAssignmentChange" ADD CONSTRAINT "DutyAssignmentChange_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TeamAttendanceDay" ADD CONSTRAINT "TeamAttendanceDay_teamMemberId_fkey" FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamAttendanceDay" ADD CONSTRAINT "TeamAttendanceDay_overriddenByUserId_fkey" FOREIGN KEY ("overriddenByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TeamAttendanceGroup" ADD CONSTRAINT "TeamAttendanceGroup_attendanceDayId_fkey" FOREIGN KEY ("attendanceDayId") REFERENCES "TeamAttendanceDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamAttendanceGroup" ADD CONSTRAINT "TeamAttendanceGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamAttendanceGroup" ADD CONSTRAINT "TeamAttendanceGroup_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
