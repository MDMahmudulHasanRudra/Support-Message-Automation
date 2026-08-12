/*
  Warnings:

  - You are about to drop the column `whatsappNotificationGroupId` on the `AutomationSettings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "AutomationSettings" DROP COLUMN "whatsappNotificationGroupId",
ADD COLUMN     "whatsappNotificationGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
