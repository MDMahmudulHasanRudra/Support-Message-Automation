-- Platform approval for the approval-only modules (MODULE_APPROVALS.md). Additive: a new table, its
-- guards, and one approval recorded for every approval-only module that is already switched on, so nothing
-- that works today stops working.

CREATE TABLE "ModuleApproval" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "targetProjectId" TEXT,
    "featureKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedByOperatorId" TEXT,
    "approvedByUsername" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByOperatorId" TEXT,
    "revokedByUsername" TEXT,
    "revokeReason" TEXT,
    CONSTRAINT "ModuleApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ModuleApproval_reason_check" CHECK (length(btrim("reason")) > 0),
    CONSTRAINT "ModuleApproval_revoke_check" CHECK (("revokedAt" IS NULL) = ("revokedByUsername" IS NULL))
);

CREATE INDEX "ModuleApproval_customerId_featureKey_idx" ON "ModuleApproval"("customerId", "featureKey");
CREATE INDEX "ModuleApproval_targetProjectId_idx" ON "ModuleApproval"("targetProjectId");
-- One ACTIVE approval per customer, project (or all projects) and module.
CREATE UNIQUE INDEX "ModuleApproval_active_key" ON "ModuleApproval"("customerId", COALESCE("targetProjectId", ''), "featureKey") WHERE "revokedAt" IS NULL;

ALTER TABLE "ModuleApproval" ADD CONSTRAINT "ModuleApproval_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModuleApproval" ADD CONSTRAINT "ModuleApproval_targetProjectId_fkey" FOREIGN KEY ("targetProjectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The audit trail cannot be rewritten: the only change allowed is revoking an active approval, once.
CREATE OR REPLACE FUNCTION module_approval_history_only() RETURNS trigger AS $$
BEGIN
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'A revoked module approval cannot be changed';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
     OR NEW."targetProjectId" IS DISTINCT FROM OLD."targetProjectId"
     OR NEW."featureKey" IS DISTINCT FROM OLD."featureKey"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
     OR NEW."approvedByOperatorId" IS DISTINCT FROM OLD."approvedByOperatorId"
     OR NEW."approvedByUsername" IS DISTINCT FROM OLD."approvedByUsername" THEN
    RAISE EXCEPTION 'A module approval cannot be rewritten; revoke it and approve again';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ModuleApproval_history_only" BEFORE UPDATE ON "ModuleApproval"
  FOR EACH ROW EXECUTE FUNCTION module_approval_history_only();

-- A project approval must name a project of the SAME customer (the founding customer owns NULL-customer projects).
CREATE OR REPLACE FUNCTION module_approval_same_customer() RETURNS trigger AS $$
DECLARE
  owner TEXT;
BEGIN
  IF NEW."targetProjectId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(p."customerId", (SELECT c."id" FROM "Customer" c WHERE c."isFounding" LIMIT 1))
    INTO owner FROM "Project" p WHERE p."id" = NEW."targetProjectId";
  IF owner IS DISTINCT FROM NEW."customerId" THEN
    RAISE EXCEPTION 'A module approval must name a project of the same customer';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ModuleApproval_same_customer" BEFORE INSERT ON "ModuleApproval"
  FOR EACH ROW EXECUTE FUNCTION module_approval_same_customer();

-- Keep what is on today: one project approval for every approval-only module already switched on.
-- A project whose owner cannot be named (no customer, no founding customer) is left as it is: its module stays
-- on (the resolver keeps a module that is on), it just cannot be switched on again until approved.
INSERT INTO "ModuleApproval" ("id", "customerId", "targetProjectId", "featureKey", "reason", "approvedAt", "approvedByUsername")
SELECT
  'mapr_' || md5(pf."projectId" || ':' || pf."key"),
  owner."customerId",
  pf."projectId",
  pf."key",
  'Already switched on before platform approval existed; kept by the migration.',
  CURRENT_TIMESTAMP,
  'migration'
FROM "ProjectFeature" pf
JOIN "Project" p ON p."id" = pf."projectId"
CROSS JOIN LATERAL (
  SELECT COALESCE(p."customerId", (SELECT c."id" FROM "Customer" c WHERE c."isFounding" LIMIT 1)) AS "customerId"
) owner
WHERE pf."enabled" = true
  AND pf."key" IN ('WHATSAPP_AVATARS', 'CLIENT_SMART_IMPORT', 'SOCIAL_STUDIO')
  AND owner."customerId" IS NOT NULL;
