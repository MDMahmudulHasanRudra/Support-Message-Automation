-- Learn HOW the support team writes (tone, greetings, how a problem is acknowledged) from the
-- replies executives actually send, and apply it to AI answers. Off by default, and the learned
-- guidance does nothing until a person approves it.
ALTER TABLE "AiSettings" ADD COLUMN IF NOT EXISTS "communicationStyleLearningEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "CommunicationStyleProfile" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "guidance" TEXT,
    "messagesAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "builtThroughAt" TIMESTAMP(3),
    "lastBuiltAt" TIMESTAMP(3),
    "lastError" TEXT,
    "humanApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunicationStyleProfile_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "CommunicationStyleProfile"
    ADD CONSTRAINT "CommunicationStyleProfile_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The Communication Style page's "Rebuild now" button.
ALTER TYPE "WorkerCommandType" ADD VALUE IF NOT EXISTS 'BUILD_COMMUNICATION_STYLE';
