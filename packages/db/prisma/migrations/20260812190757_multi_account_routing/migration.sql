-- CreateEnum
CREATE TYPE "WhatsAppServiceKey" AS ENUM ('NOTIFY_WHATSAPP', 'PRIORITY_SUPPORT');

-- CreateEnum
CREATE TYPE "WhatsAppFallbackPolicy" AS ENUM ('PRIMARY_FALLBACK', 'STRICT_NO_FALLBACK');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "accountId" TEXT;

-- AlterTable
ALTER TABLE "WhatsAppAccount" ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sessionId" TEXT;

-- Hand-added: Prisma's schema DSL has no partial/filtered unique index syntax, so this is not
-- expressible declaratively above — enforces "at most one Primary account" at the database
-- level (spec's own preference over relying on frontend/service-layer validation alone). Rows
-- with isPrimary = false are entirely excluded from the constraint, so any number of non-Primary
-- accounts may coexist; only a second isPrimary = true row would violate it.
CREATE UNIQUE INDEX "WhatsAppAccount_isPrimary_unique" ON "WhatsAppAccount" ("isPrimary") WHERE "isPrimary" = true;

-- AlterTable
ALTER TABLE "WorkerCommand" ADD COLUMN     "accountId" TEXT;

-- CreateTable
CREATE TABLE "WhatsAppServiceRoute" (
    "serviceKey" "WhatsAppServiceKey" NOT NULL,
    "accountId" TEXT,
    "fallbackPolicy" "WhatsAppFallbackPolicy" NOT NULL DEFAULT 'PRIMARY_FALLBACK',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppServiceRoute_pkey" PRIMARY KEY ("serviceKey")
);

-- CreateIndex
CREATE INDEX "WorkerCommand_accountId_status_idx" ON "WorkerCommand"("accountId", "status");

-- AddForeignKey
ALTER TABLE "WhatsAppServiceRoute" ADD CONSTRAINT "WhatsAppServiceRoute_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerCommand" ADD CONSTRAINT "WorkerCommand_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
