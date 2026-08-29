-- AlterEnum
-- Adds the WhatsApp Chat inbox's own outbound action type. Additive only: no existing
-- row changes, and every existing ActionType value keeps its meaning. Postgres 16
-- permits ADD VALUE inside a transaction so long as the new value is not itself used
-- in the same transaction, which this migration does not do.
ALTER TYPE "ActionType" ADD VALUE 'MANUAL_REPLY';
