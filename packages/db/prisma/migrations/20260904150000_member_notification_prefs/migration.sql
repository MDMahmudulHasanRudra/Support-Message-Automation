-- Who gets told directly, as opposed to which shared group is told. Opt-in per member per event:
-- somebody may want escalations at 2am and never want pattern suggestions.
CREATE TABLE IF NOT EXISTS "TeamMemberNotificationPreference" (
    "teamMemberId" TEXT NOT NULL,
    "event" "NotificationEvent" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamMemberNotificationPreference_pkey" PRIMARY KEY ("teamMemberId", "event")
);

CREATE INDEX IF NOT EXISTS "TeamMemberNotificationPreference_event_idx" ON "TeamMemberNotificationPreference"("event");

DO $$ BEGIN
  ALTER TABLE "TeamMemberNotificationPreference"
    ADD CONSTRAINT "TeamMemberNotificationPreference_teamMemberId_fkey"
    FOREIGN KEY ("teamMemberId") REFERENCES "InternalTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
