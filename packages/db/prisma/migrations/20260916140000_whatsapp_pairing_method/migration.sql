-- Link a WhatsApp account by typing a code into the phone, as well as by scanning a QR.
--
-- Both are official WhatsApp Web flows, and the library this worker already uses supports both:
-- `@open-wa/wa-automate@4.76.0` exposes `ConfigObject.linkCode`, which its initializer treats as a
-- strict either/or against the QR watcher -- `if (config.linkCode) race.push(linkCode(...)) else
-- race.push(smartQr(...))`. Setting it makes the library ask the page for a nine-character code
-- instead of rendering a QR, and emit that code on the SAME event the QR data URL arrives on. So
-- one column keeps holding whatever the current attempt produced, and this enum is what says how
-- to read it.
--
-- Stored on the account rather than carried by a WorkerCommand because connect() is also reached
-- from boot, from automatic drop recovery and from the registry sync -- none of which carry an
-- operator's button press. A preference that lived only in a command would silently revert to QR
-- the first time the worker restarted in the middle of a pairing.
--
-- Additive and inert. Every existing row defaults to QR_CODE, which is exactly what every existing
-- row already does, so an account that is connected or mid-pairing when this deploys is unaffected
-- and no backfill is needed. `pairingPhoneNumber` is deliberately separate from the existing
-- `phoneNumber` column: that one is what WhatsApp reports once a session is live, and writing an
-- operator's unverified input into it would make a claim about the session that nothing has
-- confirmed.
CREATE TYPE "WhatsAppPairingMethod" AS ENUM ('QR_CODE', 'PHONE_CODE');

ALTER TABLE "WhatsAppAccount"
    ADD COLUMN "pairingMethod" "WhatsAppPairingMethod" NOT NULL DEFAULT 'QR_CODE',
    ADD COLUMN "pairingPhoneNumber" TEXT;
