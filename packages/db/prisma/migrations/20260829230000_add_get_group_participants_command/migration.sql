-- AlterEnum
-- Additive: a new on-demand worker command. Postgres 16 permits ADD VALUE inside a transaction
-- provided the new value is not used in the same one, which this migration does not do.
ALTER TYPE "WorkerCommandType" ADD VALUE 'GET_GROUP_PARTICIPANTS';
