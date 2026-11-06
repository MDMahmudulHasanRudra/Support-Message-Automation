-- Unified Inbox V3, part 3: agent presence (feature UNIFIED_INBOX_V3). One new table; it expires by time
-- and holds no message text.

-- CreateTable
CREATE TABLE "ConversationPresence" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "conversationKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    "typingAt" TIMESTAMP(3),

    CONSTRAINT "ConversationPresence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationPresence_projectId_conversationKey_seenAt_idx" ON "ConversationPresence"("projectId", "conversationKey", "seenAt");

-- CreateIndex
CREATE INDEX "ConversationPresence_projectId_seenAt_idx" ON "ConversationPresence"("projectId", "seenAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationPresence_projectId_conversationKey_userId_key" ON "ConversationPresence"("projectId", "conversationKey", "userId");

-- AddForeignKey
ALTER TABLE "ConversationPresence" ADD CONSTRAINT "ConversationPresence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationPresence" ADD CONSTRAINT "ConversationPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database integrity (MULTI_PROJECT_PLAN.md §10.7): a row never changes project.
CREATE TRIGGER "ConversationPresence_projectId_immutable" BEFORE UPDATE OF "projectId" ON "ConversationPresence" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
ALTER TABLE "ConversationPresence" ADD CONSTRAINT "ConversationPresence_key_shape" CHECK ("conversationKey" ~ '^(wa:[A-Za-z0-9_-]{1,64}:[0-9A-Za-z._-]{3,64}@(g\.us|c\.us|lid)|ch:[A-Za-z0-9_-]{1,64})$');
