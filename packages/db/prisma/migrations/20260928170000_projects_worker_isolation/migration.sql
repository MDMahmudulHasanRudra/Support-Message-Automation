-- MULTI-PROJECT, PHASE 3: every row now has to name its project. See MULTI_PROJECT_PLAN.md §10.3.
--
-- Phases 1 and 2 left two things in place on purpose, because the worker still wrote without a
-- project. With Phase 3 the worker runs every piece of work inside a project too, so both go:
--
--   * The temporary DEFAULT 'proj_isp_digital' on the 70 project-scoped "projectId" columns is
--     removed. In its place is a default that refuses: project_id_required() raises, so an insert
--     that does not name a project fails instead of silently landing in ISP Digital. The
--     application's scoped clients always name one, so the function is never actually evaluated
--     by a correct write. (A plain DROP DEFAULT would do the same job at the database, but would
--     make "projectId" a required input in every generated Prisma type — hundreds of call sites
--     that the scoped client already fills in.) Metadata-only: no table is rewritten.
--   * The install-wide uniques that stood next to their per-project composites are dropped, so a
--     second project can have its own team called "Support", its own "Morning" shift, its own AI
--     model slots and so on. The composite (projectId, ...) uniques added in Phase 1 remain.
--   * The three tables keyed by a bare catalogue value — NotificationTemplate(key),
--     NotificationEventSetting(event), WhatsAppServiceRoute(serviceKey) — are re-keyed on
--     (projectId, key). Every existing row belongs to ISP Digital, so no key can collide.
--   * The install-wide "one Primary WhatsApp account" partial unique is dropped; the per-project
--     one from Phase 1 ("WhatsAppAccount_projectId_primary_key") is what remains: exactly one
--     Primary per project.
--
-- Nothing is deleted and no data changes. The removed Microsoft Teams tables are deliberately NOT
-- dropped here (see CLAUDE.md, "Microsoft Teams Integration — REMOVED").

-- 1. A default that refuses

CREATE OR REPLACE FUNCTION project_id_required() RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'projectId is required: every row belongs to a project, and there is no default project'
    USING ERRCODE = 'not_null_violation';
END;
$$;

-- 2. The 70 project-scoped columns

ALTER TABLE "AiEvidenceItem" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "AiEvidenceSnapshot" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "AiFallbackDecision" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "AiKnowledgeItem" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "AiKnowledgeVersion" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "AiModelConfig" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "AiProvider" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "AiSettings" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "AutomationExecution" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "AutomationRule" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "AutomationSettings" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "ChatCategory" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "CommunicationStyleProfile" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "ConversationAnalysisRun" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "ConversationCandidate" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "ConversationSession" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "DutyAssignment" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "DutyAssignmentChange" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "ForgeResearchTask" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "ForgeSettings" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "GroupBroadcastJob" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "GroupBroadcastSettings" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "GroupParticipantAddItem" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "GroupParticipantAddJob" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "GroupParticipantAddSettings" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "Holiday" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "InternalTeamMember" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "KnowledgeImport" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "LearningBatchJob" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "LearningSettings" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "LeaveRequest" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "LeaveType" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "Message" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "MessageDropCounter" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "Notification" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "OutboundMessage" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "PatternCandidate" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "PatternCandidateEvidence" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "ProcessingCheckpoint" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "RuleProposal" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SandboxSession" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SandboxTurn" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SavedGroupSet" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SavedReply" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "ShiftTemplate" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportActivity" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportActivitySettings" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportEscalationCase" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportEscalationEvent" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportEscalationSettings" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportKeyword" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportPriorityPolicy" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportRule" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportRuleGroup" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportRuleKeyword" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportRuleTeamMember" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "SupportSession" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "Team" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "TeamAttendanceDay" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "TeamAttendanceGroup" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "TeamManagementSettings" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "TeamMemberNotificationPreference" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "TeamMembership" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "WeeklyScheduleEntry" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "WhatsAppAccount" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "WhatsAppGroup" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "WorkerCommand" ALTER COLUMN "projectId" SET DEFAULT project_id_required();

ALTER TABLE "NotificationEventSetting" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "NotificationTemplate" ALTER COLUMN "projectId" SET DEFAULT project_id_required();
ALTER TABLE "WhatsAppServiceRoute" ALTER COLUMN "projectId" SET DEFAULT project_id_required();

-- 3. Install-wide uniques that now stop a second project from reusing a name or key

DROP INDEX "AiModelConfig_job_key";
DROP INDEX "ChatCategory_name_key";
DROP INDEX "ForgeResearchTask_signature_key";
DROP INDEX "Holiday_date_key";
DROP INDEX "InternalTeamMember_microsoftEmail_key";
DROP INDEX "InternalTeamMember_phoneNumber_key";
DROP INDEX "InternalTeamMember_whatsappId_key";
DROP INDEX "LeaveType_name_key";
DROP INDEX "PatternCandidate_patternKey_key";
DROP INDEX "RuleProposal_sourceSignature_key";
DROP INDEX "SavedGroupSet_name_key";
DROP INDEX "ShiftTemplate_name_key";
DROP INDEX "SupportPriorityPolicy_priority_key";
DROP INDEX "Team_code_key";
DROP INDEX "Team_name_key";

-- One Primary per PROJECT ("WhatsAppAccount_projectId_primary_key", Phase 1) replaces one per install.
DROP INDEX "WhatsAppAccount_isPrimary_unique";

-- 4. Catalogue-keyed tables re-keyed per project. The (projectId, key) unique index from Phase 1
--    becomes the primary key itself, so the separate index is dropped.

ALTER TABLE "NotificationTemplate" DROP CONSTRAINT "NotificationTemplate_pkey",
ADD CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("projectId", "key");
DROP INDEX "NotificationTemplate_projectId_key_key";

ALTER TABLE "NotificationEventSetting" DROP CONSTRAINT "NotificationEventSetting_pkey",
ADD CONSTRAINT "NotificationEventSetting_pkey" PRIMARY KEY ("projectId", "event");
DROP INDEX "NotificationEventSetting_projectId_event_key";

ALTER TABLE "WhatsAppServiceRoute" DROP CONSTRAINT "WhatsAppServiceRoute_pkey",
ADD CONSTRAINT "WhatsAppServiceRoute_pkey" PRIMARY KEY ("projectId", "serviceKey");
DROP INDEX "WhatsAppServiceRoute_projectId_serviceKey_key";
