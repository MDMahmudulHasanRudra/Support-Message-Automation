-- The sender's WhatsApp id with its domain (WHATSAPP_IDENTITY.md). Additive and nullable: a new
-- column with no default is a catalog-only change in PostgreSQL, so it takes no table rewrite and no
-- long lock on "Message". Existing rows stay NULL until `reconcile:messages --apply` recovers what
-- each row itself proves; every reader treats NULL as "domain unknown".
ALTER TABLE "Message" ADD COLUMN "senderJid" TEXT;
