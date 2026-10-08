-- Carry an extracted procedure through the Knowledge Builder's review step.
--
-- The conversation extractor can now emit a PROCEDURE field, but ConversationCandidate had no
-- column to hold it — so an approved candidate reached the knowledge base as an answer with its
-- steps stripped off, which is the one thing that makes a "how do I do this" entry useful.
--
-- Additive and nullable. No backfill: null is the correct value for every existing candidate,
-- because nothing had extracted a procedure when they were created, and inventing steps to fill
-- the column would be exactly the fabrication the extraction prompt forbids.
ALTER TABLE "ConversationCandidate" ADD COLUMN "procedure" TEXT;
