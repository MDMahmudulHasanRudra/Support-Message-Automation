-- Report accuracy audit (19 Oct 2026), Phase 3. Additive: two new project-owned tables.

-- Who a WhatsApp group was assigned to, and its priority, over time. The Team Report charged every
-- Missed wait to the group's assignee and threshold as they are TODAY, so reassigning a group on the
-- 20th moved the whole month's (and every earlier month's) misses to the new person. One row per
-- change, with the values before and after; a moment before the first row reads that row's "before".
-- Member ids are plain values, not a relation: history keeps a removed member's id.
CREATE TABLE "GroupResponsibilityChange" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "whatsappGroupId" TEXT NOT NULL,
    "previousAssignedTeamMemberId" TEXT,
    "previousPriority" "SupportPriority",
    "assignedTeamMemberId" TEXT,
    "priority" "SupportPriority",
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedByUserId" TEXT,

    CONSTRAINT "GroupResponsibilityChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GroupResponsibilityChange_projectId_whatsappGroupId_changed_idx" ON "GroupResponsibilityChange"("projectId", "whatsappGroupId", "changedAt");

ALTER TABLE "GroupResponsibilityChange" ADD CONSTRAINT "GroupResponsibilityChange_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A request to bring stored attribution up to date after a team member's identifiers change: the
-- team-member stamp on their messages, the member on Support Activity rows, and the Duty History days
-- those messages fall on. Written by the Team Members actions, worked by the worker.
CREATE TABLE "IdentityReattribution" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "memberIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "identifiers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedByUserId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "IdentityReattribution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IdentityReattribution_projectId_status_createdAt_idx" ON "IdentityReattribution"("projectId", "status", "createdAt");

ALTER TABLE "IdentityReattribution" ADD CONSTRAINT "IdentityReattribution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "GroupResponsibilityChange_projectId_immutable" BEFORE UPDATE OF "projectId" ON "GroupResponsibilityChange" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "IdentityReattribution_projectId_immutable" BEFORE UPDATE OF "projectId" ON "IdentityReattribution" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
