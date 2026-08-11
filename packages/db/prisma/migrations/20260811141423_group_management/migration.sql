-- AlterEnum
ALTER TYPE "WorkerCommandType" ADD VALUE 'GET_GROUP_PARTICIPANT_COUNT';

-- AlterTable
ALTER TABLE "WhatsAppGroup" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "participantCount" INTEGER;

-- CreateIndex
CREATE INDEX "WhatsAppGroup_accountId_isActive_idx" ON "WhatsAppGroup"("accountId", "isActive");

-- CreateIndex
CREATE INDEX "WhatsAppGroup_accountId_isMonitored_idx" ON "WhatsAppGroup"("accountId", "isMonitored");
