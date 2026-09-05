-- Two more response modes, so live Forge research is chosen alongside the other sources rather
-- than through a separate switch.
--
-- This migration ONLY adds the enum values. Postgres refuses to use a new enum value in the same
-- transaction that added it ("unsafe use of new value"), and Prisma runs one migration per
-- transaction — so the data move that depends on these lives in the next migration, not here.
ALTER TYPE "AiResponseMode" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_PLUS_FORGE';
ALTER TYPE "AiResponseMode" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_FORGE_GENERAL';
