-- Website live chat (WEBSITE_CHAT.md). Additive: one enum value, two nullable/defaulted columns, one table.
-- Rollback: DROP TABLE "WebChatVisitor"; ALTER TABLE "ChannelConnection" DROP COLUMN "widgetSettings", DROP COLUMN "allowedOrigins";
--           (the WEBCHAT enum value stays; it is unused once no connection has it)

-- AlterEnum
ALTER TYPE "ChannelType" ADD VALUE 'WEBCHAT';

-- AlterTable
ALTER TABLE "ChannelConnection" ADD COLUMN     "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "widgetSettings" JSONB;

-- CreateTable
CREATE TABLE "WebChatVisitor" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "connectionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "verifiedExternalId" TEXT,
    "name" TEXT,
    "email" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebChatVisitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebChatVisitor_tokenHash_key" ON "WebChatVisitor"("tokenHash");

-- CreateIndex
CREATE INDEX "WebChatVisitor_connectionId_createdAt_idx" ON "WebChatVisitor"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "WebChatVisitor_ipHash_createdAt_idx" ON "WebChatVisitor"("ipHash", "createdAt");

-- AddForeignKey
ALTER TABLE "WebChatVisitor" ADD CONSTRAINT "WebChatVisitor_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebChatVisitor" ADD CONSTRAINT "WebChatVisitor_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Project integrity (MULTI_PROJECT_PLAN.md §10.7).
CREATE TRIGGER "WebChatVisitor_projectId_immutable" BEFORE UPDATE OF "projectId" ON "WebChatVisitor" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "WebChatVisitor_connectionId_same_project" AFTER INSERT OR UPDATE OF "connectionId", "projectId" ON "WebChatVisitor" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('ChannelConnection', 'connectionId');
