-- WhatsApp Message & Media Storage (MEDIA_STORAGE.md).
--
-- Three project-scoped tables, all new; nothing existing is altered:
--   MessageMedia          one row per WhatsApp attachment: metadata and a storage key. The file
--                         itself lives in media storage (a volume), never in Postgres.
--   MediaStorageSettings  per project: which media types are fetched, and retention.
--   MediaCleanupJob       background, batched removal of stored files older than a date.
--
-- The retired Teams tables that `prisma migrate diff` proposes dropping are deliberately left alone
-- (CLAUDE.md, "Microsoft Teams Integration — REMOVED").

-- CreateEnum
CREATE TYPE "MessageMediaType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER', 'GIF', 'OTHER');

-- CreateEnum
CREATE TYPE "MessageMediaStatus" AS ENUM ('PENDING', 'DOWNLOADING', 'STORED', 'NOT_STORED', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "MediaCleanupTrigger" AS ENUM ('MANUAL', 'RETENTION');

-- CreateEnum
CREATE TYPE "MediaCleanupStatus" AS ENUM ('SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "MessageMedia" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "messageId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT,
    "mediaType" "MessageMediaType" NOT NULL,
    "waType" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileName" TEXT,
    "declaredSizeBytes" BIGINT,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" INTEGER,
    "isAnimated" BOOLEAN NOT NULL DEFAULT false,
    "storageKey" TEXT,
    "thumbnailKey" TEXT,
    "status" "MessageMediaStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "lastError" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "downloadStartedAt" TIMESTAMP(3),
    "download" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "storedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MessageMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaStorageSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "storeImages" BOOLEAN NOT NULL DEFAULT true,
    "storeVideos" BOOLEAN NOT NULL DEFAULT true,
    "storeAudio" BOOLEAN NOT NULL DEFAULT true,
    "storeDocuments" BOOLEAN NOT NULL DEFAULT true,
    "storeStickers" BOOLEAN NOT NULL DEFAULT true,
    "storeGifs" BOOLEAN NOT NULL DEFAULT true,
    "storeOther" BOOLEAN NOT NULL DEFAULT true,
    "retentionDays" INTEGER,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaStorageSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaCleanupJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "trigger" "MediaCleanupTrigger" NOT NULL,
    "status" "MediaCleanupStatus" NOT NULL DEFAULT 'SCHEDULED',
    "olderThan" TIMESTAMP(3) NOT NULL,
    "retentionDays" INTEGER,
    "totalCandidates" INTEGER,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "deletedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "freedBytes" BIGINT NOT NULL DEFAULT 0,
    "cursorCreatedAt" TIMESTAMP(3),
    "cursorId" TEXT,
    "lastError" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaCleanupJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageMedia_messageId_key" ON "MessageMedia"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageMedia_storageKey_key" ON "MessageMedia"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "MessageMedia_thumbnailKey_key" ON "MessageMedia"("thumbnailKey");

-- CreateIndex
CREATE INDEX "MessageMedia_status_nextAttemptAt_idx" ON "MessageMedia"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "MessageMedia_projectId_status_createdAt_idx" ON "MessageMedia"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MessageMedia_projectId_status_mediaType_idx" ON "MessageMedia"("projectId", "status", "mediaType");

-- CreateIndex
CREATE UNIQUE INDEX "MediaStorageSettings_projectId_key" ON "MediaStorageSettings"("projectId");

-- CreateIndex
CREATE INDEX "MediaCleanupJob_status_createdAt_idx" ON "MediaCleanupJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MediaCleanupJob_projectId_createdAt_idx" ON "MediaCleanupJob"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "MessageMedia" ADD CONSTRAINT "MessageMedia_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageMedia" ADD CONSTRAINT "MessageMedia_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageMedia" ADD CONSTRAINT "MessageMedia_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageMedia" ADD CONSTRAINT "MessageMedia_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "WhatsAppGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaStorageSettings" ADD CONSTRAINT "MediaStorageSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaStorageSettings" ADD CONSTRAINT "MediaStorageSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaCleanupJob" ADD CONSTRAINT "MediaCleanupJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaCleanupJob" ADD CONSTRAINT "MediaCleanupJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 7 integrity: a media row's message, account and group must be in its own project, and no
-- row may change project.
CREATE CONSTRAINT TRIGGER "MessageMedia_messageId_same_project" AFTER INSERT OR UPDATE OF "messageId", "projectId" ON "MessageMedia" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('Message', 'messageId');
CREATE CONSTRAINT TRIGGER "MessageMedia_accountId_same_project" AFTER INSERT OR UPDATE OF "accountId", "projectId" ON "MessageMedia" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppAccount', 'accountId');
CREATE CONSTRAINT TRIGGER "MessageMedia_groupId_same_project" AFTER INSERT OR UPDATE OF "groupId", "projectId" ON "MessageMedia" FOR EACH ROW EXECUTE FUNCTION enforce_same_project('WhatsAppGroup', 'groupId');
CREATE TRIGGER "MessageMedia_projectId_immutable" BEFORE UPDATE OF "projectId" ON "MessageMedia" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "MediaStorageSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "MediaStorageSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "MediaCleanupJob_projectId_immutable" BEFORE UPDATE OF "projectId" ON "MediaCleanupJob" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- Every existing project gets its settings row now, with the defaults: every media type stored,
-- kept indefinitely. ISP Digital's singleton keeps the id "global", as its other settings do.
INSERT INTO "MediaStorageSettings" ("id", "projectId", "updatedAt")
SELECT CASE WHEN "id" = 'proj_isp_digital' THEN 'global' ELSE "id" END, "id", CURRENT_TIMESTAMP
FROM "Project"
ON CONFLICT DO NOTHING;
