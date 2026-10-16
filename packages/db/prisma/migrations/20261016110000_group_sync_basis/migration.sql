-- Group sync: record what a finished sync's result rests on (PHASE2.md Stage 2).
--
-- Additive only: one NULLABLE text column on "WhatsAppAccount". Catalog-only change (no default, no
-- rewrite, no lock beyond the brief ALTER). The previous application never reads or writes it, so old
-- and new code run against this schema side by side. Values are validated in code
-- (packages/shared/src/groupSyncBasis.ts), not by an enum, so adding a basis later needs no migration.
--
-- Rollback: drop the column (it holds a label only; nothing depends on it).

ALTER TABLE "WhatsAppAccount" ADD COLUMN "groupSyncBasis" TEXT;
