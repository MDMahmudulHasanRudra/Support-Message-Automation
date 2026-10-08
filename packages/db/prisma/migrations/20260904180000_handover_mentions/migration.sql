-- Let the AI tag a team member inside the customer's own group when it hands over, so the request
-- for help lands where the conversation is. Off by default: it puts an extra message in front of
-- the customer.
ALTER TABLE "AiSettings" ADD COLUMN IF NOT EXISTS "mentionTeamOnHandover" BOOLEAN NOT NULL DEFAULT false;

-- Mentions travel with the queued message, because the outbound queue is the only send path.
ALTER TABLE "OutboundMessage" ADD COLUMN IF NOT EXISTS "mentions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
