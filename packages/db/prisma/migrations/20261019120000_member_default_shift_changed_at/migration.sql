-- Team Report audit (19 Oct 2026): when a member's default shift was last changed, on its own column.
-- Support Overtime applies a default shift only to days after it was set, and read that moment from
-- the member's `updatedAt` — which any edit moves (a rename, a phone number, a login link), so one
-- unrelated edit silently dropped the default shift from every past day and changed past overtime.
-- Additive; existing rows keep exactly today's reading (their `updatedAt`).
ALTER TABLE "InternalTeamMember" ADD COLUMN "defaultShiftChangedAt" TIMESTAMP(3);
UPDATE "InternalTeamMember" SET "defaultShiftChangedAt" = "updatedAt" WHERE "defaultShiftTemplateId" IS NOT NULL;
