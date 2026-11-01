-- Meta expansion A3 (docs/meta-expansion/09): a messaging channel (Messenger, Instagram, Telegram) that needs
-- reconnecting is announced through the Notification Center, like a WhatsApp number that stops collecting.
-- Its own migration: a new enum value cannot be used in the transaction that adds it.
-- Additive; unused it is harmless (an enum value cannot be removed in place).
ALTER TYPE "NotificationEvent" ADD VALUE IF NOT EXISTS 'CHANNEL_NEEDS_RECONNECT';
