-- Report accuracy audit (19 Oct 2026): one customer wait, one row in Response Time / Unanswered Groups.
--
-- A `SupportResponseEpisode` is kept per group ROW (account + group), so when two of our numbers are
-- in one WhatsApp group the same wait is two episodes, answered by the same reply — and Response Time
-- counted one answer twice and averaged over the duplicate. `isTwin` marks every copy after the first
-- of one wait (same project, same WhatsApp group, same first customer message time); the readers show
-- twins only when one account is chosen. Additive: a column with a default, then a backfill.

ALTER TABLE "SupportResponseEpisode" ADD COLUMN "isTwin" BOOLEAN NOT NULL DEFAULT false;

-- The copy kept is the Primary account's, then the oldest episode.
UPDATE "SupportResponseEpisode" e
SET "isTwin" = true
FROM (
  SELECT ep."id",
         ROW_NUMBER() OVER (
           PARTITION BY ep."projectId", g."whatsappGroupId", ep."firstIncomingAt"
           ORDER BY a."isPrimary" DESC, ep."createdAt" ASC, ep."id" ASC
         ) AS rn
  FROM "SupportResponseEpisode" ep
  JOIN "WhatsAppGroup" g ON g."id" = ep."groupId"
  JOIN "WhatsAppAccount" a ON a."id" = ep."accountId"
) ranked
WHERE ranked."id" = e."id" AND ranked.rn > 1;

CREATE INDEX "SupportResponseEpisode_projectId_isTwin_status_idx" ON "SupportResponseEpisode"("projectId", "isTwin", "status");
