-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TeamsAccountStatus" ADD VALUE 'SYNCING';
ALTER TYPE "TeamsAccountStatus" ADD VALUE 'REAUTH_REQUIRED';

-- AlterTable
ALTER TABLE "TeamsChannel" ADD COLUMN     "isEnabledForAutomation" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "TeamsTeam" ADD COLUMN     "isEnabledForAutomation" BOOLEAN NOT NULL DEFAULT true;

