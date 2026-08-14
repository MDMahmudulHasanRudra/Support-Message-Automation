-- AlterEnum
ALTER TYPE "WhatsAppServiceKey" ADD VALUE 'CONVERSATION_LEARNING';

-- AlterTable
ALTER TABLE "LearningSettings" ADD COLUMN     "unknownPatternCooldownMinutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "unknownPatternNotificationsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "relatedPatternCandidateId" TEXT;

-- AlterTable
ALTER TABLE "PatternCandidate" ADD COLUMN     "unhandledCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unknownPatternNotifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Notification_relatedPatternCandidateId_idx" ON "Notification"("relatedPatternCandidateId");

-- CreateIndex
CREATE INDEX "PatternCandidate_unhandledCount_lastSeenAt_idx" ON "PatternCandidate"("unhandledCount", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_relatedPatternCandidateId_fkey" FOREIGN KEY ("relatedPatternCandidateId") REFERENCES "PatternCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
