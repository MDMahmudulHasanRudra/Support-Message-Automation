-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SupportActivityCountingPeriod" ADD VALUE 'WEEKLY';
ALTER TYPE "SupportActivityCountingPeriod" ADD VALUE 'MONTHLY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SupportActivityTriggerType" ADD VALUE 'REPLY_TO_CUSTOMER';
ALTER TYPE "SupportActivityTriggerType" ADD VALUE 'MENTION';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "mentionedPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "quotedMessageId" TEXT;

-- CreateIndex
CREATE INDEX "Message_quotedMessageId_idx" ON "Message"("quotedMessageId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_quotedMessageId_fkey" FOREIGN KEY ("quotedMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
