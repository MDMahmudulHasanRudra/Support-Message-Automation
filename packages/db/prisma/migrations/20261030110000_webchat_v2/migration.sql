-- Website chat v2 (WEBSITE_CHAT.md): typing in both directions, the page a visitor wrote from, and a
-- site-signed phone number for linking a visitor to a client. Additive, nullable columns only.
ALTER TABLE "WebChatVisitor" ADD COLUMN "phone" TEXT,
  ADD COLUMN "pageUrl" TEXT,
  ADD COLUMN "typingAt" TIMESTAMP(3);
ALTER TABLE "ChannelConversation" ADD COLUMN "agentTypingAt" TIMESTAMP(3);
