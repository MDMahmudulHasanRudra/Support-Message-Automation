-- Phase 2, Stage 5 (PHASE2.md): reports credit a team member's messages only from this moment on.
-- Additive and nullable: NULL (every existing row) keeps today's attribution exactly.
-- Rollback: ALTER TABLE "InternalTeamMember" DROP COLUMN "attributeFrom";
ALTER TABLE "InternalTeamMember" ADD COLUMN "attributeFrom" TIMESTAMP(3);
