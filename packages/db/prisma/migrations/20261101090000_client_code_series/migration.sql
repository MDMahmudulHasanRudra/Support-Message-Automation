-- Project client codes (CLIENT_CODES.md). Additive only: two new project-owned tables, one index on Client, and a
-- backfill that gives every existing project its code series. NO client's code is changed here: existing codes
-- ("CL-000041") stay exactly as they are until a Main Admin reviews and applies a conversion for a project.
-- New clients get "0001"-style codes from the moment this is deployed.

-- CreateTable
CREATE TABLE "ProjectClientCodeSeries" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "tenantKey" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "minWidth" INTEGER NOT NULL DEFAULT 4,
    "nextSerial" DECIMAL(38,0) NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ProjectClientCodeSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientCodeAlias" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "clientId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "canonical" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "replacedBy" TEXT,
    "batchId" TEXT,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientCodeAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectClientCodeSeries_tenantKey_prefix_key" ON "ProjectClientCodeSeries"("tenantKey", "prefix");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectClientCodeSeries_projectId_version_key" ON "ProjectClientCodeSeries"("projectId", "version");

-- CreateIndex
CREATE INDEX "ClientCodeAlias_clientId_idx" ON "ClientCodeAlias"("clientId");

-- CreateIndex
CREATE INDEX "ClientCodeAlias_projectId_batchId_idx" ON "ClientCodeAlias"("projectId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientCodeAlias_projectId_canonical_key" ON "ClientCodeAlias"("projectId", "canonical");

-- AddForeignKey
ALTER TABLE "ProjectClientCodeSeries" ADD CONSTRAINT "ProjectClientCodeSeries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientCodeAlias" ADD CONSTRAINT "ClientCodeAlias_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientCodeAlias" ADD CONSTRAINT "ClientCodeAlias_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One live series per project; the rules a series must keep, whoever writes it.
CREATE UNIQUE INDEX "ProjectClientCodeSeries_live_key" ON "ProjectClientCodeSeries"("projectId") WHERE "retiredAt" IS NULL;
ALTER TABLE "ProjectClientCodeSeries"
  ADD CONSTRAINT "ProjectClientCodeSeries_prefix_check" CHECK ("prefix" ~ '^[A-Z]{0,8}$'),
  ADD CONSTRAINT "ProjectClientCodeSeries_primary_check" CHECK ("isPrimary" = ("prefix" = '')),
  ADD CONSTRAINT "ProjectClientCodeSeries_width_check" CHECK ("minWidth" BETWEEN 1 AND 12),
  ADD CONSTRAINT "ProjectClientCodeSeries_serial_check" CHECK ("nextSerial" >= 1 AND "nextSerial" = trunc("nextSerial"));
ALTER TABLE "ClientCodeAlias"
  ADD CONSTRAINT "ClientCodeAlias_reason_check" CHECK ("reason" IN ('CONVERSION', 'MANUAL_CHANGE', 'IMPORT_SOURCE')),
  ADD CONSTRAINT "ClientCodeAlias_canonical_check" CHECK ("canonical" = upper(btrim("code")) AND "canonical" <> '');

-- Code lookups compare case-insensitively ("n0001" is "N0001").
CREATE INDEX "Client_projectId_upper_code_idx" ON "Client"("projectId", upper("code"));

-- Project integrity: a row never changes project, and an alias belongs to a client of its own project.
CREATE TRIGGER "ProjectClientCodeSeries_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ProjectClientCodeSeries" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ClientCodeAlias_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ClientCodeAlias" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "ClientCodeAlias_clientId_same_project" AFTER INSERT OR UPDATE OF "clientId", "projectId" ON "ClientCodeAlias" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Client', 'clientId');

-- Aliases are history: never rewritten (a client's deletion still removes its own).
CREATE OR REPLACE FUNCTION client_code_alias_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ClientCodeAlias rows are history and are never changed'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "ClientCodeAlias_append_only" BEFORE UPDATE ON "ClientCodeAlias" FOR EACH ROW EXECUTE FUNCTION client_code_alias_append_only();

-- Backfill: one series per existing project. Per customer (or the original installation), the OLDEST project
-- (created first, id breaking ties) is the primary — numbers only, "0001". Every other project gets the first
-- free prefix from its own slug's letters ("noor" → N, then NO, NOO …), then the slug's initials, then its first
-- letter plus another letter. The same order as suggestCodePrefix (packages/shared/src/clientCodes.ts).
-- Serials start at 1; a code already in use is skipped when issued, so nothing existing can collide.
DO $$
DECLARE
  p record;
  tenant text;
  letters text;
  initials text;
  candidate text;
  n int;
  alphabet text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  i int;
  j int;
BEGIN
  FOR p IN
    SELECT pr."id", pr."name", pr."slug", CASE WHEN cu."isFounding" THEN NULL ELSE pr."customerId" END AS "customerId"
      FROM "Project" pr LEFT JOIN "Customer" cu ON cu."id" = pr."customerId"
     ORDER BY COALESCE(CASE WHEN cu."isFounding" THEN NULL ELSE pr."customerId" END, ''), pr."createdAt", pr."id"
  LOOP
    -- The founding customer's projects (no customer, or the founding customer's own id) are one tenant.
    tenant := COALESCE(p."customerId", '__founding__');
    candidate := NULL;
    IF NOT EXISTS (SELECT 1 FROM "ProjectClientCodeSeries" s WHERE s."tenantKey" = tenant AND s."prefix" = '') THEN
      candidate := '';
    ELSE
      letters := upper(regexp_replace(p."slug", '[^A-Za-z]', '', 'g'));
      IF letters = '' THEN letters := upper(regexp_replace(p."name", '[^A-Za-z]', '', 'g')); END IF;
      IF letters = '' THEN letters := 'P'; END IF;
      FOR n IN 1..LEAST(length(letters), 8) LOOP
        IF NOT EXISTS (SELECT 1 FROM "ProjectClientCodeSeries" s WHERE s."tenantKey" = tenant AND s."prefix" = left(letters, n)) THEN
          candidate := left(letters, n);
          EXIT;
        END IF;
      END LOOP;
      IF candidate IS NULL THEN
        SELECT upper(regexp_replace(string_agg(left(w, 1), ''), '[^A-Za-z]', '', 'g')) INTO initials
          FROM regexp_split_to_table(p."slug", '[^A-Za-z0-9]+') AS w WHERE w <> '';
        IF length(initials) > 1 AND NOT EXISTS (SELECT 1 FROM "ProjectClientCodeSeries" s WHERE s."tenantKey" = tenant AND s."prefix" = left(initials, 8)) THEN
          candidate := left(initials, 8);
        END IF;
      END IF;
      i := 1;
      WHILE candidate IS NULL AND i <= 26 LOOP
        IF NOT EXISTS (SELECT 1 FROM "ProjectClientCodeSeries" s WHERE s."tenantKey" = tenant AND s."prefix" = left(letters, 1) || substr(alphabet, i, 1)) THEN
          candidate := left(letters, 1) || substr(alphabet, i, 1);
        END IF;
        i := i + 1;
      END LOOP;
      i := 1;
      WHILE candidate IS NULL AND i <= 26 LOOP
        j := 1;
        WHILE candidate IS NULL AND j <= 26 LOOP
          IF NOT EXISTS (SELECT 1 FROM "ProjectClientCodeSeries" s WHERE s."tenantKey" = tenant AND s."prefix" = left(letters, 1) || substr(alphabet, i, 1) || substr(alphabet, j, 1)) THEN
            candidate := left(letters, 1) || substr(alphabet, i, 1) || substr(alphabet, j, 1);
          END IF;
          j := j + 1;
        END LOOP;
        i := i + 1;
      END LOOP;
      IF candidate IS NULL THEN
        RAISE EXCEPTION 'No free client-code prefix for project % (%)', p."slug", p."id";
      END IF;
    END IF;
    INSERT INTO "ProjectClientCodeSeries" ("id", "projectId", "tenantKey", "prefix", "isPrimary", "minWidth", "nextSerial", "version", "updatedAt")
    VALUES ('ccs_' || md5(p."id"), p."id", tenant, candidate, candidate = '', 4, 1, 1, CURRENT_TIMESTAMP);
  END LOOP;
END;
$$;
