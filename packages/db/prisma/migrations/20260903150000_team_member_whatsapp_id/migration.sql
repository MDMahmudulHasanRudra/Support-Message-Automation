-- WhatsApp now identifies group participants by a "LID" rather than their phone number, so a
-- team member's real number never appears on their messages. Match on the identifier that
-- actually arrives, additively — phone-number matching keeps working unchanged.
ALTER TABLE "InternalTeamMember" ADD COLUMN IF NOT EXISTS "whatsappId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "InternalTeamMember_whatsappId_key" ON "InternalTeamMember"("whatsappId");
