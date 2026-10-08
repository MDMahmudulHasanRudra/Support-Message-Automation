-- Notification Center: give notifications an event identity so they can be routed, muted and
-- reported on per reason. NotificationType was the channel all along, so nothing recorded WHY a
-- notification was raised.

DO $$ BEGIN
  CREATE TYPE "NotificationEvent" AS ENUM (
    'RULE_NOTIFY_TEAMS',
    'RULE_NOTIFY_WHATSAPP',
    'AI_HUMAN_FALLBACK',
    'UNKNOWN_PATTERN',
    'SUPPORT_ESCALATION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Nullable: rows written before this existed have no event to attribute, and inferring one from
-- the payload would be a guess presented as fact.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "event" "NotificationEvent";

CREATE TABLE IF NOT EXISTS "NotificationEventSetting" (
    "event" "NotificationEvent" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sendToTeams" BOOLEAN NOT NULL DEFAULT true,
    "sendToWhatsApp" BOOLEAN NOT NULL DEFAULT true,
    "whatsappGroupIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationEventSetting_pkey" PRIMARY KEY ("event")
);

-- Useful for the per-event counts the Notification Center shows.
CREATE INDEX IF NOT EXISTS "Notification_event_createdAt_idx" ON "Notification"("event", "createdAt");
