-- Website Chat V3 (docs/website-chat-v3): the installation check. Nullable columns only; nothing existing changes.
ALTER TABLE "ChannelConnection" ADD COLUMN "widgetSeenAt" TIMESTAMP(3);
ALTER TABLE "ChannelConnection" ADD COLUMN "widgetSeenOrigin" TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN "widgetSeenVersion" TEXT;
ALTER TABLE "ChannelConnection" ADD COLUMN "widgetRefusedAt" TIMESTAMP(3);
ALTER TABLE "ChannelConnection" ADD COLUMN "widgetRefusedOrigin" TEXT;
