-- Research a customer's question against the product source at the moment they ask it, rather than
-- handing over and researching it for the next person. Off by default; also requires the Forge
-- integration to be enabled, since it reads that project's source.
ALTER TABLE "AiSettings" ADD COLUMN IF NOT EXISTS "deepAnswerEnabled" BOOLEAN NOT NULL DEFAULT false;
