-- Backup alert delivery per recipient, with a bounded retry of confirmed non-delivery (docs/get-assist-ultimate/19 §7).
-- Platform data, no projectId. Additive only.

-- AlterTable
ALTER TABLE "BackupAlert" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BackupAlertDelivery" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "sendingAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupAlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupAlertDelivery_status_nextAttemptAt_idx" ON "BackupAlertDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "BackupAlertDelivery_alertId_recipient_key" ON "BackupAlertDelivery"("alertId", "recipient");

-- AddForeignKey
ALTER TABLE "BackupAlertDelivery" ADD CONSTRAINT "BackupAlertDelivery_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "BackupAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A delivery is one of five states; anything else is a bug, refused here.
ALTER TABLE "BackupAlertDelivery" ADD CONSTRAINT "BackupAlertDelivery_status_check" CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN'));
