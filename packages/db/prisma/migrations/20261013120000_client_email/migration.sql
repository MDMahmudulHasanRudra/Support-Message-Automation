-- Email (SMTP) module (CLIENT_CENTER_PLAN.md §3.1, stage 4C): settings and a send queue.
--
-- Additive only: three new enums, two new EMPTY project-scoped tables and one permission row. No existing
-- table, column, index or row is touched, so it is safe on a live database. The feature it belongs to
-- (CLIENT_CENTER) ships OFF for every project. No provider is chosen and no credential exists: until an
-- authorized admin enters settings and a test message is accepted, Email is "not connected".
--
-- Rollback (before any email was queued): drop the two tables and the three types, delete the
-- 'communications.manage_email' Permission row and the migration's _prisma_migrations row.

-- CreateEnum
CREATE TYPE "EmailTlsMode" AS ENUM ('STARTTLS', 'TLS');

-- CreateEnum
CREATE TYPE "EmailPurpose" AS ENUM ('TEST');

-- CreateEnum
CREATE TYPE "EmailOutboxStatus" AS ENUM ('QUEUED', 'SENDING', 'ACCEPTED', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "EmailSettings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT NOT NULL DEFAULT '',
    "port" INTEGER NOT NULL DEFAULT 587,
    "tlsMode" "EmailTlsMode" NOT NULL DEFAULT 'STARTTLS',
    "username" TEXT NOT NULL DEFAULT '',
    "passwordCiphertext" TEXT,
    "fromName" TEXT NOT NULL DEFAULT '',
    "fromAddress" TEXT NOT NULL DEFAULT '',
    "replyTo" TEXT,
    "maxPerMinute" INTEGER NOT NULL DEFAULT 10,
    "maxPerDay" INTEGER NOT NULL DEFAULT 500,
    "settingsVersion" INTEGER NOT NULL DEFAULT 1,
    "verifiedVersion" INTEGER,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailOutbox" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT project_id_required(),
    "purpose" "EmailPurpose" NOT NULL,
    "status" "EmailOutboxStatus" NOT NULL DEFAULT 'QUEUED',
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "settingsVersion" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "sendingStartedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSettings_projectId_key" ON "EmailSettings"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailOutbox_projectId_idempotencyKey_key" ON "EmailOutbox"("projectId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "EmailOutbox_projectId_status_nextAttemptAt_idx" ON "EmailOutbox"("projectId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_projectId_createdAt_idx" ON "EmailOutbox"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "EmailSettings" ADD CONSTRAINT "EmailSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Phase 7 integrity (MULTI_PROJECT_PLAN.md §10.7): no row changes project. Neither table points at another
-- project-owned table (users are platform-wide), so there is no same-project trigger to add.
CREATE TRIGGER "EmailSettings_projectId_immutable" BEFORE UPDATE OF "projectId" ON "EmailSettings" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();
CREATE TRIGGER "EmailOutbox_projectId_immutable" BEFORE UPDATE OF "projectId" ON "EmailOutbox" FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable();

-- The permission key. Nobody is granted anything: the Administrator module is re-synced to every key by the
-- seed. It does not end in ".view", so Read Only does not receive it.
INSERT INTO "Permission" ("id", "key", "label", "category") VALUES
  (gen_random_uuid()::text, 'communications.manage_email', 'Manage Email Settings', 'Communications')
ON CONFLICT ("key") DO NOTHING;
