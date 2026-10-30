-- Social Studio (SOCIAL_STUDIO.md): Get Assist's own social publishing. Connections, accounts, posts with
-- per-account publish jobs and their attempts, history, the media library, campaigns and templates.
-- New, empty, project-owned tables only.

-- CreateTable
CREATE TABLE "SocialConnection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "externalUserId" TEXT NOT NULL,
    "externalUserName" TEXT,
    "credentialCiphertext" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "declinedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectedByUsername" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "connectionId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "parentExternalId" TEXT,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "pictureUrl" TEXT,
    "tokenCiphertext" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "title" TEXT,
    "content" TEXT NOT NULL,
    "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publishMode" TEXT NOT NULL DEFAULT 'SCHEDULE',
    "scheduledAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "campaignId" TEXT,
    "aiAssisted" BOOLEAN NOT NULL DEFAULT false,
    "reviewerUsername" TEXT,
    "createdByUsername" TEXT NOT NULL,
    "updatedByUsername" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedByUsername" TEXT,
    "approvalHash" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedByUsername" TEXT,
    "reviewNote" TEXT,
    "scheduledAtRequest" TIMESTAMP(3),
    "scheduledByUsername" TEXT,
    "duplicatedFromId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPostTarget" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "postId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contentOverride" TEXT,
    "settings" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "externalId" TEXT,
    "externalContainerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "permalink" TEXT,
    "error" TEXT,
    "publishedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "metrics" JSONB,
    "metricsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPostTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPublishAttempt" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "targetId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "claimToken" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "requestSentAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "message" TEXT,
    "externalId" TEXT,

    CONSTRAINT "SocialPublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPostEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "postId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorUsername" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialPostEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialMediaAsset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "storageKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "folder" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "altText" TEXT,
    "uploadedByUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SocialMediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialCampaign" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "startsOn" TIMESTAMP(3),
    "endsOn" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "leadId" TEXT,
    "createdByUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdByUsername" TEXT NOT NULL,
    "updatedByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SocialConnection_projectId_provider_externalUserId_key" ON "SocialConnection"("projectId", "provider", "externalUserId");

-- CreateIndex
CREATE INDEX "SocialAccount_connectionId_idx" ON "SocialAccount"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_projectId_platform_externalId_key" ON "SocialAccount"("projectId", "platform", "externalId");

-- CreateIndex
CREATE INDEX "SocialPost_projectId_status_idx" ON "SocialPost"("projectId", "status");

-- CreateIndex
CREATE INDEX "SocialPost_projectId_scheduledAt_idx" ON "SocialPost"("projectId", "scheduledAt");

-- CreateIndex
CREATE INDEX "SocialPost_campaignId_idx" ON "SocialPost"("campaignId");

-- CreateIndex
CREATE INDEX "SocialPostTarget_status_dueAt_idx" ON "SocialPostTarget"("status", "dueAt");

-- CreateIndex
CREATE INDEX "SocialPostTarget_accountId_publishedAt_idx" ON "SocialPostTarget"("accountId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPostTarget_postId_accountId_key" ON "SocialPostTarget"("postId", "accountId");

-- CreateIndex
CREATE INDEX "SocialPublishAttempt_targetId_attemptNo_idx" ON "SocialPublishAttempt"("targetId", "attemptNo");

-- CreateIndex
CREATE INDEX "SocialPostEvent_postId_createdAt_idx" ON "SocialPostEvent"("postId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialMediaAsset_storageKey_key" ON "SocialMediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "SocialMediaAsset_projectId_deletedAt_createdAt_idx" ON "SocialMediaAsset"("projectId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "SocialCampaign_projectId_status_idx" ON "SocialCampaign"("projectId", "status");

-- CreateIndex
CREATE INDEX "SocialTemplate_projectId_kind_idx" ON "SocialTemplate"("projectId", "kind");

-- AddForeignKey
ALTER TABLE "SocialConnection" ADD CONSTRAINT "SocialConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SocialConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SocialCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostTarget" ADD CONSTRAINT "SocialPostTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostTarget" ADD CONSTRAINT "SocialPostTarget_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostTarget" ADD CONSTRAINT "SocialPostTarget_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublishAttempt" ADD CONSTRAINT "SocialPublishAttempt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublishAttempt" ADD CONSTRAINT "SocialPublishAttempt_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "SocialPostTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostEvent" ADD CONSTRAINT "SocialPostEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostEvent" ADD CONSTRAINT "SocialPostEvent_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialMediaAsset" ADD CONSTRAINT "SocialMediaAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialCampaign" ADD CONSTRAINT "SocialCampaign_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialCampaign" ADD CONSTRAINT "SocialCampaign_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "SalesLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialTemplate" ADD CONSTRAINT "SocialTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Project integrity (MULTI_PROJECT_PLAN.md §10.7): a row never changes project, and never points at a
-- parent in another project.
CREATE TRIGGER "SocialConnection_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialConnection" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SocialAccount_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialAccount" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SocialPost_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialPost" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SocialPostTarget_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialPostTarget" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SocialPublishAttempt_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialPublishAttempt" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SocialPostEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialPostEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SocialMediaAsset_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialMediaAsset" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SocialCampaign_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialCampaign" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "SocialTemplate_projectId_immutable" BEFORE UPDATE OF "projectId" ON "SocialTemplate" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "SocialAccount_connectionId_same_project" AFTER INSERT OR UPDATE OF "connectionId", "projectId" ON "SocialAccount" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SocialConnection', 'connectionId');
CREATE CONSTRAINT TRIGGER "SocialPost_campaignId_same_project" AFTER INSERT OR UPDATE OF "campaignId", "projectId" ON "SocialPost" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SocialCampaign', 'campaignId');
CREATE CONSTRAINT TRIGGER "SocialPostTarget_postId_same_project" AFTER INSERT OR UPDATE OF "postId", "projectId" ON "SocialPostTarget" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SocialPost', 'postId');
CREATE CONSTRAINT TRIGGER "SocialPostTarget_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "SocialPostTarget" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SocialAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "SocialPublishAttempt_targetId_same_project" AFTER INSERT OR UPDATE OF "targetId", "projectId" ON "SocialPublishAttempt" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SocialPostTarget', 'targetId');
CREATE CONSTRAINT TRIGGER "SocialPostEvent_postId_same_project" AFTER INSERT OR UPDATE OF "postId", "projectId" ON "SocialPostEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SocialPost', 'postId');
CREATE CONSTRAINT TRIGGER "SocialCampaign_leadId_same_project" AFTER INSERT OR UPDATE OF "leadId", "projectId" ON "SocialCampaign" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('SalesLead', 'leadId');

-- A post's history and comments are what happened; they are never rewritten.
CREATE OR REPLACE FUNCTION social_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Social post history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SocialPostEvent_append_only" BEFORE UPDATE ON "SocialPostEvent" FOR EACH ROW EXECUTE FUNCTION social_event_append_only();
