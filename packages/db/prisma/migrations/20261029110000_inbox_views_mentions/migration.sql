-- Unified inbox: saved views, @mention notifications, channel conversation assignment history
-- (INBOX_WORKSPACE.md). Additive: three new tables.
-- Rollback: DROP TABLE "ConversationEvent", "InboxMention", "InboxSavedView";

-- CreateTable
CREATE TABLE "InboxSavedView" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxSavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxMention" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "noteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "channelConversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboxSavedView_projectId_ownerId_idx" ON "InboxSavedView"("projectId", "ownerId");

-- CreateIndex
CREATE INDEX "InboxSavedView_projectId_shared_idx" ON "InboxSavedView"("projectId", "shared");

-- CreateIndex
CREATE INDEX "InboxMention_projectId_userId_readAt_idx" ON "InboxMention"("projectId", "userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboxMention_noteId_userId_key" ON "InboxMention"("noteId", "userId");

-- CreateIndex
CREATE INDEX "ConversationEvent_channelConversationId_createdAt_idx" ON "ConversationEvent"("channelConversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "InboxSavedView" ADD CONSTRAINT "InboxSavedView_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxSavedView" ADD CONSTRAINT "InboxSavedView_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxMention" ADD CONSTRAINT "InboxMention_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxMention" ADD CONSTRAINT "InboxMention_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "ConversationNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxMention" ADD CONSTRAINT "InboxMention_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "ChannelConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "InboxSavedView" ADD CONSTRAINT "InboxSavedView_name_bounded" CHECK (length("name") BETWEEN 1 AND 60);
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_kind_known" CHECK ("kind" IN ('ASSIGNEE', 'TEAM', 'STATUS'));

-- Project integrity (MULTI_PROJECT_PLAN.md §10.7).
CREATE TRIGGER "InboxSavedView_projectId_immutable" BEFORE UPDATE OF "projectId" ON "InboxSavedView" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "InboxMention_projectId_immutable" BEFORE UPDATE OF "projectId" ON "InboxMention" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "ConversationEvent_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ConversationEvent" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "InboxMention_noteId_same_project" AFTER INSERT OR UPDATE OF "noteId", "projectId" ON "InboxMention" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ConversationNote', 'noteId');
CREATE CONSTRAINT TRIGGER "ConversationEvent_channelConversationId_same_project" AFTER INSERT OR UPDATE OF "channelConversationId", "projectId" ON "ConversationEvent" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConversation', 'channelConversationId');
