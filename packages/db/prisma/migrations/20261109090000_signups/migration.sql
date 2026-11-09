-- Public sign-up (SIGNUP.md): a pricing page and a form that puts a request in front of a platform operator. Additive
-- only. Off until an operator switches it on, and no plan is public until one is marked so.

CREATE TYPE "SignupStatus" AS ENUM ('EMAIL_PENDING', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED');

ALTER TABLE "Plan" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlatformBillingSettings" ADD COLUMN "signupEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "SignupRequest" (
    "id" TEXT NOT NULL,
    "status" "SignupStatus" NOT NULL DEFAULT 'EMAIL_PENDING',
    "businessName" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "slug" TEXT NOT NULL,
    "planId" TEXT,
    "verifyTokenHash" TEXT NOT NULL,
    "verifyExpiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "emailCiphertext" TEXT,
    "emailSentAt" TIMESTAMP(3),
    "emailError" TEXT,
    "addressHash" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "rejectReason" TEXT,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignupRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SignupRequest_verifyTokenHash_key" ON "SignupRequest"("verifyTokenHash");
CREATE INDEX "SignupRequest_status_createdAt_idx" ON "SignupRequest"("status", "createdAt");
CREATE INDEX "SignupRequest_addressHash_createdAt_idx" ON "SignupRequest"("addressHash", "createdAt");
-- One open request per email address: pressing the form again cannot pile up requests.
CREATE UNIQUE INDEX "SignupRequest_open_email_key" ON "SignupRequest"("email") WHERE "status" IN ('EMAIL_PENDING', 'PENDING_APPROVAL');

ALTER TABLE "SignupRequest" ADD CONSTRAINT "SignupRequest_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SignupRequest" ADD CONSTRAINT "SignupRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
