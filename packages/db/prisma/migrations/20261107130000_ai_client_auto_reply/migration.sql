-- AI answering a verified customer's own account question by itself in a one-to-one WhatsApp chat
-- (AI_CLIENT_ANSWERS.md). Additive and off by default: nothing changes until an admin switches it on.
ALTER TABLE "AiSettings" ADD COLUMN "clientAccountAutoReply" BOOLEAN NOT NULL DEFAULT false;
