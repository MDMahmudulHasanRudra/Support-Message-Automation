-- Customer account answers (AI_CLIENT_ANSWERS.md). Additive: both AI switches are off by default, so every
-- project answers exactly as before, and every existing Copilot request carries no account permission.
ALTER TABLE "AiSettings"
  ADD COLUMN "clientAccountAnswers" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "clientDueAnswers" BOOLEAN NOT NULL DEFAULT false;

-- What the agent who asked the Copilot may see, decided by the web's permission check at request time.
ALTER TABLE "AiDraft"
  ADD COLUMN "clientAccountAllowed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "clientDuesAllowed" BOOLEAN NOT NULL DEFAULT false;
