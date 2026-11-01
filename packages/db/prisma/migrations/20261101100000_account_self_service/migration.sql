-- My account (ACCOUNT_SELF_SERVICE.md): profile, own username/password changes, two-step sign-in, photo.
-- Additive only. Also: Employee email unique per customer instead of across every customer.

ALTER TABLE "User" ADD COLUMN "phone" TEXT,
ADD COLUMN "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN "usernameChangedAt" TIMESTAMP(3),
ADD COLUMN "mfaSecretCiphertext" TEXT,
ADD COLUMN "mfaPendingSecretCiphertext" TEXT,
ADD COLUMN "mfaEnabledAt" TIMESTAMP(3),
ADD COLUMN "mfaRecoveryCodeHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "mfaLastUsedStep" BIGINT;

CREATE TABLE "UserAvatar" (
    "userId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserAvatar_pkey" PRIMARY KEY ("userId"),
    -- Same ceiling as the upload check: a profile photo is a thumbnail, never a file store.
    CONSTRAINT "UserAvatar_size_check" CHECK (octet_length("bytes") <= 204800)
);

ALTER TABLE "UserAvatar" ADD CONSTRAINT "UserAvatar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Employee email: one per customer. Two customers may each have an employee with the same address.
DROP INDEX "Employee_email_key";
CREATE UNIQUE INDEX "Employee_email_original_key" ON "Employee"("email") WHERE "customerId" IS NULL AND "email" IS NOT NULL;
CREATE UNIQUE INDEX "Employee_customerId_email_key" ON "Employee"("customerId", "email") WHERE "customerId" IS NOT NULL AND "email" IS NOT NULL;
