-- Evidence, provenance and isolation foundation.
--
-- Five concerns, one migration, because they are one change: the answer to "why did the AI say
-- that, and was it allowed to?" needs all of them at once. Every column added here is NULLABLE or
-- carries a default, so existing rows are valid the moment this runs and no backfill is required
-- for the schema to be correct.
--
-- The ONE deliberate behaviour change is the scope backfill at the end. It is called out there.

-- ---------------------------------------------------------------------------
-- 1. Knowledge scope — the data-isolation boundary.
-- ---------------------------------------------------------------------------
CREATE TYPE "AiKnowledgeScope" AS ENUM ('GLOBAL', 'GROUP', 'ACCOUNT');

ALTER TABLE "AiKnowledgeItem"
  ADD COLUMN "scope"          "AiKnowledgeScope" NOT NULL DEFAULT 'GLOBAL',
  ADD COLUMN "scopeAccountId" TEXT,
  -- SHA-256 of the canonicalised factual content. Integrity and duplicate detection only; this is
  -- a fingerprint, not encryption, and it protects nothing confidential.
  ADD COLUMN "contentHash"    TEXT,
  -- Who approved this entry for customer-facing use, and when. `humanVerified` recorded only that
  -- somebody did.
  ADD COLUMN "verifiedById"   TEXT,
  ADD COLUMN "verifiedAt"     TIMESTAMP(3);

ALTER TABLE "AiKnowledgeItem" ADD CONSTRAINT "AiKnowledgeItem_scopeAccountId_fkey"
  FOREIGN KEY ("scopeAccountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiKnowledgeItem" ADD CONSTRAINT "AiKnowledgeItem_verifiedById_fkey"
  FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The exact predicate retrieval narrows on now that scope is part of it.
CREATE INDEX "AiKnowledgeItem_humanVerified_status_scope_idx" ON "AiKnowledgeItem"("humanVerified", "status", "scope");
-- Duplicate-import detection. NOT unique: two entries may legitimately share content while
-- differing in scope or provenance, and refusing the second outright would destroy a distinct
-- procedure rather than flagging it for a person.
CREATE INDEX "AiKnowledgeItem_contentHash_idx" ON "AiKnowledgeItem"("contentHash");

-- ---------------------------------------------------------------------------
-- 2. AI interaction metadata — what it cost, how it ended, and which version of this
--    system produced it. Without the last of those, comparing two models proves nothing.
-- ---------------------------------------------------------------------------
ALTER TABLE "AiFallbackDecision"
  ADD COLUMN "latencyMs"           INTEGER,
  ADD COLUMN "finishReason"        TEXT,
  ADD COLUMN "promptVersion"       TEXT,
  ADD COLUMN "retrievalVersion"    TEXT,
  ADD COLUMN "evidenceFingerprint" TEXT,
  ADD COLUMN "correlationId"       TEXT;

CREATE INDEX "AiFallbackDecision_correlationId_idx" ON "AiFallbackDecision"("correlationId");
CREATE INDEX "AiFallbackDecision_evidenceFingerprint_idx" ON "AiFallbackDecision"("evidenceFingerprint");

-- ---------------------------------------------------------------------------
-- 3. The evidence snapshot — the persisted form of the runtime EvidenceBundle.
--
--    Stores REFERENCES, never copies. The question is reachable through the decision's message and
--    the evidence text through AiKnowledgeVersion; only a title is denormalised, so a snapshot
--    whose knowledge item was later deleted is still readable.
-- ---------------------------------------------------------------------------
CREATE TABLE "AiEvidenceSnapshot" (
    "id"               TEXT NOT NULL,
    "decisionId"       TEXT NOT NULL,
    "fingerprint"      TEXT NOT NULL,
    "questionShape"    TEXT NOT NULL,
    "intent"           TEXT,
    "knowledgeCount"   INTEGER NOT NULL DEFAULT 0,
    "workflowCount"    INTEGER NOT NULL DEFAULT 0,
    "missingProcedure" BOOLEAN NOT NULL DEFAULT false,
    -- Reserved for the conflict-detection stage, which is deliberately not built yet. Always 0
    -- today, and honest about it: nothing writes a conflict, so nothing may claim one was checked.
    "conflictCount"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiEvidenceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiEvidenceSnapshot_decisionId_key" ON "AiEvidenceSnapshot"("decisionId");
CREATE INDEX "AiEvidenceSnapshot_fingerprint_idx" ON "AiEvidenceSnapshot"("fingerprint");

ALTER TABLE "AiEvidenceSnapshot" ADD CONSTRAINT "AiEvidenceSnapshot_decisionId_fkey"
  FOREIGN KEY ("decisionId") REFERENCES "AiFallbackDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AiEvidenceItem" (
    "snapshotId"       TEXT NOT NULL,
    "knowledgeItemId"  TEXT,
    "knowledgeVersion" INTEGER NOT NULL,
    "rank"             INTEGER NOT NULL,
    "title"            TEXT NOT NULL,
    "scope"            "AiKnowledgeScope" NOT NULL,
    "hadProcedure"     BOOLEAN NOT NULL DEFAULT false,
    "fromSameGroup"    BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AiEvidenceItem_pkey" PRIMARY KEY ("snapshotId","rank")
);

CREATE INDEX "AiEvidenceItem_knowledgeItemId_idx" ON "AiEvidenceItem"("knowledgeItemId");

ALTER TABLE "AiEvidenceItem" ADD CONSTRAINT "AiEvidenceItem_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "AiEvidenceSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: deleting a knowledge item must never erase the record that it once
-- grounded an answer. That record is the entire purpose of this table.
ALTER TABLE "AiEvidenceItem" ADD CONSTRAINT "AiEvidenceItem_knowledgeItemId_fkey"
  FOREIGN KEY ("knowledgeItemId") REFERENCES "AiKnowledgeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Audit metadata on the existing log stream, rather than a second one.
--    Two audit tables means neither is complete.
-- ---------------------------------------------------------------------------
ALTER TABLE "SystemLog"
  ADD COLUMN "actorUserId"   TEXT,
  ADD COLUMN "targetType"    TEXT,
  ADD COLUMN "targetId"      TEXT,
  ADD COLUMN "correlationId" TEXT;

ALTER TABLE "SystemLog" ADD CONSTRAINT "SystemLog_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SystemLog_targetType_targetId_idx" ON "SystemLog"("targetType", "targetId");
CREATE INDEX "SystemLog_correlationId_idx" ON "SystemLog"("correlationId");
CREATE INDEX "SystemLog_actorUserId_createdAt_idx" ON "SystemLog"("actorUserId", "createdAt");

-- ---------------------------------------------------------------------------
-- 5. THE ONE DELIBERATE BEHAVIOUR CHANGE — read this before deploying.
--
-- Every knowledge entry carrying a `sourceGroupId` was learned FROM or researched FOR one
-- particular group: the conversation knowledge builder distils one group's chat, and the live
-- deep-answer path stores what it researched for one group's question with `humanVerified: true`.
-- Retrieval, however, filtered on `humanVerified` + `ACTIVE` and nothing else, so all of it was
-- immediately retrievable in EVERY other group. `sourceGroupId` recorded where it came from and
-- was used only as a ranking tiebreak.
--
-- This narrows those entries to the group they came from. Entries with no group — manual entries,
-- document imports, the Forge repository sync, which are all statements about the product itself —
-- keep the GLOBAL default and behave exactly as they always have.
--
-- It is the safe direction and it IS a change: a group-sourced entry stops grounding answers
-- elsewhere until somebody promotes it. That promotion is a deliberate act, which is the point —
-- "unknown or ambiguous" resolves to GROUP, and GLOBAL is earned by a person deciding it.
--
-- Reversible: `UPDATE "AiKnowledgeItem" SET "scope" = 'GLOBAL' WHERE "sourceGroupId" IS NOT NULL;`
-- restores the previous behaviour exactly, since nothing else reads this column yet.
UPDATE "AiKnowledgeItem" SET "scope" = 'GROUP' WHERE "sourceGroupId" IS NOT NULL;

-- Backfilling `verifiedAt` is deliberately NOT done. `updatedAt` is not a verification time, and
-- writing it into that column would invent an audit fact. An entry verified before this migration
-- keeps `humanVerified = true` with a null `verifiedAt`, which reads correctly as "approved, by
-- somebody, before this was recorded".
--
-- `contentHash` is likewise left null and filled on the next write of each row, rather than
-- computed here: the canonicalisation lives in application code, and duplicating it in SQL would
-- create a second definition of what a content hash is.
