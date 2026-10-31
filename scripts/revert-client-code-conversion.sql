-- Reverses ONE client-code conversion batch (CLIENT_CODES.md §Recovery). Run with psql:
--
--   psql "$DATABASE_URL" -v batch=ccb_xxxxxxxx -v apply=0 -f scripts/revert-client-code-conversion.sql   -- shows what would change
--   psql "$DATABASE_URL" -v batch=ccb_xxxxxxxx -v apply=1 -f scripts/revert-client-code-conversion.sql   -- reverts
--
-- The batch id is in the System Log entry "Client codes of … converted" (correlation id) and on every alias the
-- conversion wrote. Each client goes back to its old code only if it still has the code the batch gave it; a client
-- whose code was changed again since is left alone and listed. The aliases of the batch are removed so the old codes
-- are the clients' own again; the timeline keeps its "Client code changed" entries, and the series' next number is
-- not lowered (a number once issued is never reissued). Take a backup first.

\set ON_ERROR_STOP on
BEGIN;

SELECT a."projectId", a."clientId", c."code" AS "currentCode", a."replacedBy" AS "batchGave", a."code" AS "revertTo",
       CASE WHEN c."code" = a."replacedBy" THEN 'revert' ELSE 'SKIP: code changed since' END AS "action"
  FROM "ClientCodeAlias" a JOIN "Client" c ON c."id" = a."clientId" AND c."projectId" = a."projectId"
 WHERE a."batchId" = :'batch' AND a."reason" = 'CONVERSION'
 ORDER BY a."projectId", a."createdAt";

\if :apply
  CREATE TEMP TABLE revert_rows ON COMMIT DROP AS
    SELECT a."id" AS "aliasId", a."projectId", a."clientId", a."code", a."replacedBy"
      FROM "ClientCodeAlias" a JOIN "Client" c ON c."id" = a."clientId" AND c."projectId" = a."projectId"
     WHERE a."batchId" = :'batch' AND a."reason" = 'CONVERSION' AND c."code" = a."replacedBy";

  -- Free the old codes first (they are aliases), then give them back.
  DELETE FROM "ClientCodeAlias" WHERE "id" IN (SELECT "aliasId" FROM revert_rows);
  UPDATE "Client" c SET "code" = r."code", "updatedAt" = now()
    FROM revert_rows r WHERE c."id" = r."clientId" AND c."projectId" = r."projectId" AND c."code" = r."replacedBy";
  INSERT INTO "ClientActivity" ("id", "projectId", "clientId", "type", "summary", "details")
    SELECT 'cact_rv_' || md5(r."aliasId"), r."projectId", r."clientId", 'CODE_CHANGED',
           'Client code conversion reverted: ' || r."replacedBy" || ' back to ' || r."code",
           jsonb_build_object('from', r."replacedBy", 'to', r."code", 'revertedBatch', :'batch')
      FROM revert_rows r;
  SELECT count(*) AS "reverted" FROM revert_rows;
  COMMIT;
\else
  ROLLBACK;
  \echo 'Preview only. Nothing was changed. Run again with -v apply=1 to revert.'
\endif
