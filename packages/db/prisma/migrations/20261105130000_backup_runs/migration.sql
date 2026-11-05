-- Backup runs and backup alerts (docs/get-assist-ultimate/19-backup-and-restore.md §7). Platform data: no
-- projectId. Additive only.

-- CreateEnum
CREATE TYPE "BackupRunStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "status" "BackupRunStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "databaseBytes" BIGINT,
    "mediaBytes" BIGINT,
    "sessionsIncluded" BOOLEAN NOT NULL DEFAULT false,
    "commitSha" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BackupRun_reason_length" CHECK ("reason" IS NULL OR length("reason") <= 300)
);

-- CreateTable
CREATE TABLE "BackupAlert" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupRun_finishedAt_idx" ON "BackupRun"("finishedAt");

-- CreateIndex
CREATE INDEX "BackupRun_status_finishedAt_idx" ON "BackupRun"("status", "finishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BackupAlert_key_key" ON "BackupAlert"("key");
