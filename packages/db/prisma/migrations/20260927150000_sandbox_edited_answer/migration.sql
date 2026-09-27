-- AI Sandbox: an admin's corrected answer, kept beside the original AI answer (responseText is never
-- overwritten). Additive, all nullable: existing turns read as unedited.
ALTER TABLE "SandboxTurn" ADD COLUMN "editedResponseText" TEXT;
ALTER TABLE "SandboxTurn" ADD COLUMN "editedById" TEXT;
ALTER TABLE "SandboxTurn" ADD COLUMN "editedAt" TIMESTAMP(3);
