-- Group descriptions (WHATSAPP_AVATARS.md §7): read from what WhatsApp Web already holds, in the same
-- group-list pass as the name. Additive and nullable; adding it does not rewrite the table.
-- Rollback: ALTER TABLE "WhatsAppGroup" DROP COLUMN "description";

ALTER TABLE "WhatsAppGroup" ADD COLUMN "description" TEXT;
