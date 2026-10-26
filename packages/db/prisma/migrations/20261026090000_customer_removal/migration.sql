-- Remove / delete a customer from the platform (CUSTOMER_REMOVAL.md). Additive: five nullable
-- columns on "Customer"; nothing existing changes meaning (NULL = a customer in use, as before).
ALTER TABLE "Customer" ADD COLUMN "removedAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "removedByUsername" TEXT;
ALTER TABLE "Customer" ADD COLUMN "removalSnapshot" JSONB;
ALTER TABLE "Customer" ADD COLUMN "purgedAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "purgedByUsername" TEXT;

-- The founding customer is the original installation: it can be neither removed nor deleted.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_founding_never_removed"
  CHECK (NOT "isFounding" OR ("removedAt" IS NULL AND "purgedAt" IS NULL));
-- A permanently deleted customer was always removed first.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_purged_is_removed"
  CHECK ("purgedAt" IS NULL OR "removedAt" IS NOT NULL);
