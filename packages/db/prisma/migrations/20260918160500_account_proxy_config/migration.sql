-- Per-account outbound proxy, read at connect time and handed to @open-wa/wa-automate as
-- `proxyServerCredentials`. Additive and inert: every column is nullable, every existing account
-- keeps connecting exactly as it does today, and only an account an admin has actually configured
-- ever passes a proxy value into the connect config.
--
-- The password is stored encrypted, reusing the SAME `encryptSecret`/`decryptSecret` this schema
-- already uses for Teams OAuth tokens and AI provider keys -- not a new mechanism for one more
-- credential.
ALTER TABLE "WhatsAppAccount"
    ADD COLUMN "proxyAddress" TEXT,
    ADD COLUMN "proxyProtocol" TEXT,
    ADD COLUMN "proxyUsername" TEXT,
    ADD COLUMN "proxyPasswordCiphertext" TEXT;
