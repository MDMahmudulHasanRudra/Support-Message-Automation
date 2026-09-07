-- Customised notification wording. Rows exist only for templates somebody edited; the defaults
-- live in code, so nothing is seeded here and an empty table is the correct initial state.
CREATE TABLE "NotificationTemplate" (
    "key" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
