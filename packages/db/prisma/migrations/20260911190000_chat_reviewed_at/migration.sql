-- Marks when a conversation was last opened in the chat inbox, so the "waiting" filter can tell
-- "nobody has looked at this" from "seen, and being handled". Nullable with no default: every
-- existing group starts unreviewed, which is the honest starting point — nobody has opened them
-- through this feature yet.
ALTER TABLE "WhatsAppGroup" ADD COLUMN "chatReviewedAt" TIMESTAMP(3);
