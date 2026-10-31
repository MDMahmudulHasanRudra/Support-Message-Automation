-- Smart Import V5 §7: amounts a spreadsheet stated for a client, retained as written. Additive: one JSONB column
-- with a constant default (no table rewrite on PostgreSQL 11+). It is never read as money owed or paid.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "importedAmounts" JSONB NOT NULL DEFAULT '[]';

