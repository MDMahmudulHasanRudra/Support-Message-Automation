-- How long an executive can go without messaging before they count as offline, and the gap that
-- splits one stretch of work from the next. Two hours by default, as requested.
--
-- One column for both readings on purpose: "is she online now" and "how long was she working" are
-- the same question about different moments. They were previously answered with different
-- thresholds — availability used a hardcoded 30 minutes while work time was measured per group per
-- day — which could show somebody offline in the middle of a stretch the same page was counting.
ALTER TABLE "SupportActivitySettings"
  ADD COLUMN "offlineAfterMinutes" INTEGER NOT NULL DEFAULT 120;
