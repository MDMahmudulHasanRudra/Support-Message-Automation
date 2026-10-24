-- Smart Bulk Import: an expiry imported with no start date is recorded on the client ("Expiry on
-- record"), never invented into a subscription term (SMART_IMPORT.md §11). Additive, nullable, unused
-- unless such a row is imported. Rollback: the columns can be dropped.
ALTER TABLE "Client" ADD COLUMN "recordedExpiryDate" DATE,
  ADD COLUMN "recordedExpiryService" TEXT,
  ADD COLUMN "recordedExpiryAt" TIMESTAMP(3);
