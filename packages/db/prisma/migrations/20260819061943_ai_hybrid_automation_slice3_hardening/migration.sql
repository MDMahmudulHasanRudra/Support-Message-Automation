-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN     "aiReplyCooldownSeconds" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "humanTakeoverCooldownMinutes" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "WhatsAppGroup" ADD COLUMN     "aiSuppressedUntil" TIMESTAMP(3);
