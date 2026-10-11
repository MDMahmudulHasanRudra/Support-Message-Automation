-- Support Overtime (TEAM_OVERTIME.md): the regular duty length used for a member-day with work and
-- no schedule. Additive, with a constant default: PostgreSQL stores it in the catalog, so existing
-- rows read 480 (8 hours) without a table rewrite.
ALTER TABLE "SupportActivitySettings" ADD COLUMN "overtimeFallbackDutyMinutes" INTEGER NOT NULL DEFAULT 480;
