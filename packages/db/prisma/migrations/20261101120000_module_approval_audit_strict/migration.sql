-- Module approvals: a stricter audit guard (MODULE_APPROVALS.md). A follow-up rather than an edit of
-- 20261101110000_module_approvals, which may already be applied somewhere: CREATE OR REPLACE swaps the function
-- body under the existing trigger, and the constraint and the delete guard are new.
--
-- An approval row may change exactly once, from active to revoked, and only completely: revokedAt,
-- revokedByOperatorId, revokedByUsername and revokeReason are all set together, in one statement, with every
-- approval field untouched. Nothing else is ever an allowed update. A revoked row never changes again.

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
  -- Still active: no revocation field may be filled in on its own.
  IF NEW."revokedAt" IS NULL THEN
    IF NEW."revokedByOperatorId" IS NOT NULL OR NEW."revokedByUsername" IS NOT NULL OR NEW."revokeReason" IS NOT NULL THEN
      RAISE EXCEPTION 'Revocation details can only be recorded together with the revocation itself';
    END IF;
    RETURN NEW;
  END IF;
  -- The revocation: complete, by a named operator, with a reason, not before the approval and not in the future.
  IF NEW."revokedByOperatorId" IS NULL OR btrim(NEW."revokedByOperatorId") = ''
     OR NEW."revokedByUsername" IS NULL OR btrim(NEW."revokedByUsername") = ''
     OR NEW."revokeReason" IS NULL OR btrim(NEW."revokeReason") = '' THEN
    RAISE EXCEPTION 'A revocation needs the operator and a reason';
  END IF;
  IF NEW."revokedAt" < OLD."approvedAt" OR NEW."revokedAt" > (now() AT TIME ZONE 'UTC') + interval '5 minutes' THEN
    RAISE EXCEPTION 'A revocation time must be after the approval and not in the future';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The same rule as a constraint, so no row can hold half a revocation whatever wrote it.
ALTER TABLE "ModuleApproval" ADD CONSTRAINT "ModuleApproval_revocation_complete_check" CHECK (
  ("revokedAt" IS NULL AND "revokedByOperatorId" IS NULL AND "revokedByUsername" IS NULL AND "revokeReason" IS NULL)
  OR ("revokedAt" IS NOT NULL AND "revokedByOperatorId" IS NOT NULL AND "revokedByUsername" IS NOT NULL AND "revokeReason" IS NOT NULL)
);

-- The audit trail cannot be deleted directly. A row goes only with its customer or its workspace (the ON DELETE
-- CASCADE of the foreign keys, which fires this trigger one level down: pg_trigger_depth() > 1).
CREATE OR REPLACE FUNCTION module_approval_no_direct_delete() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'Module approvals are an audit trail and cannot be deleted; revoke instead';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ModuleApproval_no_direct_delete" BEFORE DELETE ON "ModuleApproval"
  FOR EACH ROW EXECUTE FUNCTION module_approval_no_direct_delete();
