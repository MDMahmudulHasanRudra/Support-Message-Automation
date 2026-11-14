-- Business Apps: the real Commerce connection (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md).
-- Additive only: nullable columns on ProjectAppInstallation. No existing row changes.
ALTER TABLE "ProjectAppInstallation"
  ADD COLUMN "externalTenantId" TEXT,
  ADD COLUMN "externalConnectionId" TEXT,
  ADD COLUMN "credentialCiphertext" TEXT,
  ADD COLUMN "credentialHint" TEXT,
  ADD COLUMN "credentialIssuedAt" TIMESTAMP(3);

-- A hint is a short non-secret prefix; a long value here would be a secret stored in the wrong column.
ALTER TABLE "ProjectAppInstallation"
  ADD CONSTRAINT "ProjectAppInstallation_credentialHint_length_check"
  CHECK ("credentialHint" IS NULL OR char_length("credentialHint") <= 40);

-- A stored credential is always an encryptSecret envelope, never a plaintext Commerce key ("cmk_…").
ALTER TABLE "ProjectAppInstallation"
  ADD CONSTRAINT "ProjectAppInstallation_credential_encrypted_check"
  CHECK ("credentialCiphertext" IS NULL OR "credentialCiphertext" NOT LIKE 'cmk%');
