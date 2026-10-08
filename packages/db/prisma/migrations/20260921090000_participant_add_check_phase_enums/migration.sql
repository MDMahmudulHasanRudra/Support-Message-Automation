-- The membership-check phase for Add Number to Groups.
--
-- ONLY enum values here: Postgres cannot use a new enum value in the same transaction that adds
-- it, so the columns that will store these land in the migration immediately after this one. Same
-- split as 20260918160000_message_actions_and_group_commands, and as the original LOGOUT change.
--
-- Why the phase exists at all: every item used to be claimable work the moment it was created, so
-- the only way to learn somebody was already in a group was to attempt the add and be refused.
-- Adding a participant is the strongest ban signal WhatsApp reacts to, which makes "find out by
-- trying" the one strategy this feature cannot use.

-- A job now spends time being checked, and then waits — possibly indefinitely — for a person to
-- decide. Neither state holds a queue slot.
ALTER TYPE "GroupParticipantAddJobStatus" ADD VALUE 'CHECKING' BEFORE 'QUEUED';
ALTER TYPE "GroupParticipantAddJobStatus" ADD VALUE 'AWAITING_REVIEW' BEFORE 'QUEUED';

-- The check phase's own outcomes, ahead of the existing add-phase values.
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'PENDING_CHECK' BEFORE 'PENDING';
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'CHECKING' BEFORE 'PENDING';
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'READY' BEFORE 'PENDING';
-- Absence that could not be PROVEN, kept distinct from READY on purpose: a roster identifying
-- people by LID cannot be matched against a phone number, and reading "no match" as "not a member"
-- is precisely how a redundant add gets sent.
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'CANNOT_VERIFY' BEFORE 'PENDING';
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'ALREADY_MEMBER' BEFORE 'PENDING';
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'INVALID_NUMBER' BEFORE 'PENDING';
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'NOT_ON_WHATSAPP' BEFORE 'PENDING';
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'NO_PERMISSION' BEFORE 'PENDING';
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'GROUP_UNAVAILABLE' BEFORE 'PENDING';
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'CHECK_FAILED' BEFORE 'PENDING';
ALTER TYPE "GroupParticipantAddItemStatus" ADD VALUE 'NOT_SELECTED' BEFORE 'PENDING';
