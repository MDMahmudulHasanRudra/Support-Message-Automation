-- MULTI-PROJECT, PHASE 1: the database foundation. See MULTI_PROJECT_PLAN.md §6 and §10.1.
--
-- The current installation becomes the project "ISP Digital" (id proj_isp_digital, slug
-- isp-digital). Purely additive: nothing is deleted, renamed (except below) or rewritten, and no
-- permission, role or permission assignment is touched.
--
--   * Project, ProjectAccess, ProjectFeature are created; ISP Digital is inserted and every existing
--     user is given access to it. What users may DO is still decided by the existing permission
--     system, unchanged.
--   * "projectId" is added to the 70 project-scoped tables as NOT NULL DEFAULT 'proj_isp_digital'.
--     On Postgres 11+ a constant default is metadata-only: no table, including "Message", is
--     rewritten. The default STAYS until Phase 2, so every existing write keeps landing in ISP
--     Digital without a code change. "SystemLog" gets a nullable "projectId" (null = platform).
--   * Composite (projectId, ...) uniques are added NEXT TO the existing install-wide ones, which
--     stay until Phase 2 moves the code onto the new ones. With one project the data is identical,
--     so none of them can fail.
--   * Every projectId foreign key is added NOT VALID: no scan, no long lock. The next migration
--     (…_validate) checks them under a lock that does not block writes.
--   * ForgeSettings' own "projectId"/"projectName" (the Forge repository project) are renamed to
--     "forgeProjectId"/"forgeProjectName", so "projectId" means one thing everywhere.


-- 1. Projects

CREATE TYPE "ProjectStatus" AS ENUM ('SETUP', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'SETUP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectAccess" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAccess_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectFeature" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectFeature_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

CREATE INDEX "ProjectAccess_userId_idx" ON "ProjectAccess"("userId");

CREATE UNIQUE INDEX "ProjectAccess_projectId_userId_key" ON "ProjectAccess"("projectId", "userId");

CREATE UNIQUE INDEX "ProjectFeature_projectId_key_key" ON "ProjectFeature"("projectId", "key");

ALTER TABLE "ProjectAccess" ADD CONSTRAINT "ProjectAccess_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectAccess" ADD CONSTRAINT "ProjectAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectFeature" ADD CONSTRAINT "ProjectFeature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "Project" ("id", "name", "slug", "description", "status", "updatedAt")
VALUES ('proj_isp_digital', 'ISP Digital', 'isp-digital',
        'The original Softify Assist installation. Every record that existed before multi-project support belongs here.',
        'ACTIVE', CURRENT_TIMESTAMP);

-- Project ACCESS only. Roles and permissions are not touched: each user keeps exactly the
-- abilities their existing role gives them, now exercised inside ISP Digital.
INSERT INTO "ProjectAccess" ("id", "projectId", "userId")
SELECT 'pa_' || u."id", 'proj_isp_digital', u."id" FROM "User" u;

-- 2. Forge's own project columns move aside

ALTER TABLE "ForgeSettings" RENAME COLUMN "projectId" TO "forgeProjectId";
ALTER TABLE "ForgeSettings" RENAME COLUMN "projectName" TO "forgeProjectName";
ALTER TABLE "ForgeSettings" ADD COLUMN "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

-- 3. projectId on every project-scoped table

ALTER TABLE "TeamMemberNotificationPreference" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "NotificationTemplate" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "NotificationEventSetting" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "WhatsAppAccount" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "WhatsAppServiceRoute" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SavedGroupSet" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SavedReply" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "ChatCategory" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "WhatsAppGroup" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "InternalTeamMember" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "Team" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "TeamMembership" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "Message" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AutomationRule" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AutomationExecution" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "OutboundMessage" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "GroupBroadcastJob" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "GroupBroadcastSettings" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "GroupParticipantAddJob" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "GroupParticipantAddItem" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "GroupParticipantAddSettings" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "Notification" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "WorkerCommand" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "ProcessingCheckpoint" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "MessageDropCounter" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AutomationSettings" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SystemLog" ADD COLUMN     "projectId" TEXT;

ALTER TABLE "KnowledgeImport" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AiSettings" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AiProvider" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AiModelConfig" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AiKnowledgeItem" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AiKnowledgeVersion" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AiFallbackDecision" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AiEvidenceSnapshot" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "AiEvidenceItem" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportPriorityPolicy" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportEscalationSettings" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportEscalationCase" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportEscalationEvent" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "ConversationSession" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "LearningSettings" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "LearningBatchJob" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "PatternCandidate" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "PatternCandidateEvidence" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "RuleProposal" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportActivitySettings" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportKeyword" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportRule" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportRuleKeyword" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportRuleGroup" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportRuleTeamMember" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportActivity" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SupportSession" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "ForgeResearchTask" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "CommunicationStyleProfile" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "ShiftTemplate" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "WeeklyScheduleEntry" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "DutyAssignment" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "DutyAssignmentChange" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "LeaveType" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "LeaveRequest" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "Holiday" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "TeamManagementSettings" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "TeamAttendanceDay" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "TeamAttendanceGroup" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SandboxSession" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "SandboxTurn" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "ConversationAnalysisRun" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

ALTER TABLE "ConversationCandidate" ADD COLUMN     "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital';

-- 4. Per-project uniques (alongside the existing ones) and singleton projectId uniques

CREATE UNIQUE INDEX "NotificationTemplate_projectId_key_key" ON "NotificationTemplate"("projectId", "key");

CREATE UNIQUE INDEX "NotificationEventSetting_projectId_event_key" ON "NotificationEventSetting"("projectId", "event");

CREATE UNIQUE INDEX "WhatsAppServiceRoute_projectId_serviceKey_key" ON "WhatsAppServiceRoute"("projectId", "serviceKey");

CREATE UNIQUE INDEX "SavedGroupSet_projectId_name_key" ON "SavedGroupSet"("projectId", "name");

CREATE UNIQUE INDEX "ChatCategory_projectId_name_key" ON "ChatCategory"("projectId", "name");

CREATE UNIQUE INDEX "InternalTeamMember_projectId_phoneNumber_key" ON "InternalTeamMember"("projectId", "phoneNumber");

CREATE UNIQUE INDEX "InternalTeamMember_projectId_whatsappId_key" ON "InternalTeamMember"("projectId", "whatsappId");

CREATE UNIQUE INDEX "InternalTeamMember_projectId_microsoftEmail_key" ON "InternalTeamMember"("projectId", "microsoftEmail");

CREATE UNIQUE INDEX "Team_projectId_name_key" ON "Team"("projectId", "name");

CREATE UNIQUE INDEX "Team_projectId_code_key" ON "Team"("projectId", "code");

CREATE UNIQUE INDEX "GroupBroadcastSettings_projectId_key" ON "GroupBroadcastSettings"("projectId");

CREATE UNIQUE INDEX "GroupParticipantAddSettings_projectId_key" ON "GroupParticipantAddSettings"("projectId");

CREATE UNIQUE INDEX "AutomationSettings_projectId_key" ON "AutomationSettings"("projectId");

CREATE UNIQUE INDEX "AiSettings_projectId_key" ON "AiSettings"("projectId");

CREATE UNIQUE INDEX "AiModelConfig_projectId_job_key" ON "AiModelConfig"("projectId", "job");

CREATE UNIQUE INDEX "SupportPriorityPolicy_projectId_priority_key" ON "SupportPriorityPolicy"("projectId", "priority");

CREATE UNIQUE INDEX "SupportEscalationSettings_projectId_key" ON "SupportEscalationSettings"("projectId");

CREATE UNIQUE INDEX "LearningSettings_projectId_key" ON "LearningSettings"("projectId");

CREATE UNIQUE INDEX "PatternCandidate_projectId_patternKey_key" ON "PatternCandidate"("projectId", "patternKey");

CREATE UNIQUE INDEX "RuleProposal_projectId_sourceSignature_key" ON "RuleProposal"("projectId", "sourceSignature");

CREATE UNIQUE INDEX "SupportActivitySettings_projectId_key" ON "SupportActivitySettings"("projectId");

CREATE UNIQUE INDEX "ForgeSettings_projectId_key" ON "ForgeSettings"("projectId");

CREATE UNIQUE INDEX "ForgeResearchTask_projectId_signature_key" ON "ForgeResearchTask"("projectId", "signature");

CREATE UNIQUE INDEX "CommunicationStyleProfile_projectId_key" ON "CommunicationStyleProfile"("projectId");

CREATE UNIQUE INDEX "ShiftTemplate_projectId_name_key" ON "ShiftTemplate"("projectId", "name");

CREATE UNIQUE INDEX "LeaveType_projectId_name_key" ON "LeaveType"("projectId", "name");

CREATE UNIQUE INDEX "Holiday_projectId_date_key" ON "Holiday"("projectId", "date");

CREATE UNIQUE INDEX "TeamManagementSettings_projectId_key" ON "TeamManagementSettings"("projectId");

-- One Primary account per PROJECT, next to the existing one-per-install partial unique.
CREATE UNIQUE INDEX "WhatsAppAccount_projectId_primary_key" ON "WhatsAppAccount"("projectId") WHERE "isPrimary" = true;

-- 5. Foreign keys to Project, NOT VALID (validated by the next migration)

ALTER TABLE "TeamMemberNotificationPreference" ADD CONSTRAINT "TeamMemberNotificationPreference_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "NotificationEventSetting" ADD CONSTRAINT "NotificationEventSetting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "WhatsAppServiceRoute" ADD CONSTRAINT "WhatsAppServiceRoute_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SavedGroupSet" ADD CONSTRAINT "SavedGroupSet_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SavedReply" ADD CONSTRAINT "SavedReply_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ChatCategory" ADD CONSTRAINT "ChatCategory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "WhatsAppGroup" ADD CONSTRAINT "WhatsAppGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "InternalTeamMember" ADD CONSTRAINT "InternalTeamMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Team" ADD CONSTRAINT "Team_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Message" ADD CONSTRAINT "Message_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "GroupBroadcastJob" ADD CONSTRAINT "GroupBroadcastJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "GroupBroadcastSettings" ADD CONSTRAINT "GroupBroadcastSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "GroupParticipantAddJob" ADD CONSTRAINT "GroupParticipantAddJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "GroupParticipantAddItem" ADD CONSTRAINT "GroupParticipantAddItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "GroupParticipantAddSettings" ADD CONSTRAINT "GroupParticipantAddSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "WorkerCommand" ADD CONSTRAINT "WorkerCommand_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ProcessingCheckpoint" ADD CONSTRAINT "ProcessingCheckpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "MessageDropCounter" ADD CONSTRAINT "MessageDropCounter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AutomationSettings" ADD CONSTRAINT "AutomationSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SystemLog" ADD CONSTRAINT "SystemLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "KnowledgeImport" ADD CONSTRAINT "KnowledgeImport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AiSettings" ADD CONSTRAINT "AiSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AiProvider" ADD CONSTRAINT "AiProvider_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AiModelConfig" ADD CONSTRAINT "AiModelConfig_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AiKnowledgeItem" ADD CONSTRAINT "AiKnowledgeItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AiKnowledgeVersion" ADD CONSTRAINT "AiKnowledgeVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AiFallbackDecision" ADD CONSTRAINT "AiFallbackDecision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AiEvidenceSnapshot" ADD CONSTRAINT "AiEvidenceSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AiEvidenceItem" ADD CONSTRAINT "AiEvidenceItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportPriorityPolicy" ADD CONSTRAINT "SupportPriorityPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportEscalationSettings" ADD CONSTRAINT "SupportEscalationSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportEscalationCase" ADD CONSTRAINT "SupportEscalationCase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportEscalationEvent" ADD CONSTRAINT "SupportEscalationEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ConversationSession" ADD CONSTRAINT "ConversationSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "LearningSettings" ADD CONSTRAINT "LearningSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "LearningBatchJob" ADD CONSTRAINT "LearningBatchJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "PatternCandidate" ADD CONSTRAINT "PatternCandidate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "PatternCandidateEvidence" ADD CONSTRAINT "PatternCandidateEvidence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "RuleProposal" ADD CONSTRAINT "RuleProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportActivitySettings" ADD CONSTRAINT "SupportActivitySettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportKeyword" ADD CONSTRAINT "SupportKeyword_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportRule" ADD CONSTRAINT "SupportRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportRuleKeyword" ADD CONSTRAINT "SupportRuleKeyword_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportRuleGroup" ADD CONSTRAINT "SupportRuleGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportRuleTeamMember" ADD CONSTRAINT "SupportRuleTeamMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportActivity" ADD CONSTRAINT "SupportActivity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ForgeSettings" ADD CONSTRAINT "ForgeSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ForgeResearchTask" ADD CONSTRAINT "ForgeResearchTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "CommunicationStyleProfile" ADD CONSTRAINT "CommunicationStyleProfile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ShiftTemplate" ADD CONSTRAINT "ShiftTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "WeeklyScheduleEntry" ADD CONSTRAINT "WeeklyScheduleEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "DutyAssignment" ADD CONSTRAINT "DutyAssignment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "DutyAssignmentChange" ADD CONSTRAINT "DutyAssignmentChange_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "LeaveType" ADD CONSTRAINT "LeaveType_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "TeamManagementSettings" ADD CONSTRAINT "TeamManagementSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "TeamAttendanceDay" ADD CONSTRAINT "TeamAttendanceDay_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "TeamAttendanceGroup" ADD CONSTRAINT "TeamAttendanceGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SandboxSession" ADD CONSTRAINT "SandboxSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "SandboxTurn" ADD CONSTRAINT "SandboxTurn_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ConversationAnalysisRun" ADD CONSTRAINT "ConversationAnalysisRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "ConversationCandidate" ADD CONSTRAINT "ConversationCandidate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
