-- countingMode was a setting that did nothing.
--
-- It was saved, validated, offered in the settings form and reported by the AI assistant, but no
-- report ever read it: its only consumer, computeSupportActivityCount(), had zero callers. An
-- admin could switch between "Unique Group" and "Every Activity", save, and every number on every
-- page stayed identical.
--
-- It is also redundant now, which is why this drops it rather than wiring it up. The Activity Feed
-- shows unique groups AND total activities as separate tiles, so the number the mode would have
-- picked is already both on screen, and PER_TEAM_MEMBER is a breakdown rather than a count — it
-- has its own table on Team Performance. Wiring it in would have meant hiding one of two numbers
-- people can already see.
--
-- No historical value: a settings column, not a record of anything that happened.
ALTER TABLE "SupportActivitySettings" DROP COLUMN IF EXISTS "countingMode";

-- The enum exists only for that column.
DROP TYPE IF EXISTS "SupportActivityCountingMode";
