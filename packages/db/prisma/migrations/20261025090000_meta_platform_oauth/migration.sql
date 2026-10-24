-- Meta one-click connections (docs/meta-integration/04-database-and-migration-plan.md).
-- Additive only: three enums, two new tables, five nullable/defaulted columns on ChannelConnection and
-- one partial unique index. Every existing row reads as MANUAL, exactly as before.
-- Rollback (before any PLATFORM row exists): drop the index, the columns, the two tables and the enums.

-- CreateEnum
CREATE TYPE "ChannelAuthMode" AS ENUM ('MANUAL', 'PLATFORM');

-- CreateEnum
CREATE TYPE "MetaOAuthPurpose" AS ENUM ('CONNECT', 'RECONNECT');

-- CreateEnum
CREATE TYPE "MetaOAuthStatus" AS ENUM ('STARTED', 'AUTHORIZED', 'COMPLETED', 'CANCELLED', 'FAILED', 'EXPIRED');

-- AlterTable
ALTER TABLE "ChannelConnection" ADD COLUMN     "authMode" "ChannelAuthMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "metaOAuthSessionId" TEXT,
ADD COLUMN     "metaUserId" TEXT,
ADD COLUMN     "pageTasks" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "MetaOAuthSession" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "userId" TEXT NOT NULL,
    "purpose" "MetaOAuthPurpose" NOT NULL,
    "channelType" "ChannelType",
    "connectionId" TEXT,
    "status" "MetaOAuthStatus" NOT NULL DEFAULT 'STARTED',
    "stateHash" TEXT NOT NULL,
    "browserBindingHash" TEXT NOT NULL,
    "claimHash" TEXT,
    "claimedAt" TIMESTAMP(3),
    "returnOrigin" TEXT NOT NULL,
    "returnPath" TEXT NOT NULL,
    "metaUserId" TEXT,
    "metaUserName" TEXT,
    "userTokenCiphertext" TEXT,
    "userTokenExpiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "declinedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaOAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaDataDeletionRequest" (
    "id" TEXT NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "metaUserIdHash" TEXT NOT NULL,
    "connectionsAffected" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MetaDataDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaOAuthSession_stateHash_key" ON "MetaOAuthSession"("stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "MetaOAuthSession_claimHash_key" ON "MetaOAuthSession"("claimHash");

-- CreateIndex
CREATE INDEX "MetaOAuthSession_projectId_userId_createdAt_idx" ON "MetaOAuthSession"("projectId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "MetaOAuthSession_status_expiresAt_idx" ON "MetaOAuthSession"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetaDataDeletionRequest_confirmationCode_key" ON "MetaDataDeletionRequest"("confirmationCode");

-- AddForeignKey
ALTER TABLE "MetaOAuthSession" ADD CONSTRAINT "MetaOAuthSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_metaOAuthSessionId_fkey" FOREIGN KEY ("metaOAuthSessionId") REFERENCES "MetaOAuthSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 7 integrity: a session cannot move project, and a connection may only point at a session of
-- its own project.
CREATE TRIGGER "MetaOAuthSession_projectId_immutable" BEFORE UPDATE OF "projectId" ON "MetaOAuthSession" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE CONSTRAINT TRIGGER "ChannelConnection_metaOAuthSessionId_same_project" AFTER INSERT OR UPDATE OF "metaOAuthSessionId", "projectId" ON "ChannelConnection" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('MetaOAuthSession', 'metaOAuthSessionId');

-- One live one-click connection per Meta account across the WHOLE installation: the platform app has
-- one webhook for every customer, and an event is routed by the account it names. Two projects holding
-- the same account would make that routing ambiguous.
CREATE UNIQUE INDEX "ChannelConnection_platform_account_key" ON "ChannelConnection"("type", "externalAccountId") WHERE "authMode" = 'PLATFORM' AND "status" <> 'DISCONNECTED';
