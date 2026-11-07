-- Website Chat invitations (WEBSITE_CHAT.md): which invitation brought a visitor into the chat. Nullable, no rewrite.
ALTER TABLE "WebChatVisitor" ADD COLUMN "startedFrom" TEXT;
