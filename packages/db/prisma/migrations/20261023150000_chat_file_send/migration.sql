-- WhatsApp Chat: sending a photo, video, audio file, voice note or document (CHAT_FILE_SENDING.md).
-- Additive: one enum value. Nothing existing changes.
ALTER TYPE "OutboundContentType" ADD VALUE IF NOT EXISTS 'MEDIA';
