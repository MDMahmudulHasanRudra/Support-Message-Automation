-- Chat inbox organisation: categories, pinning, archiving.
--
-- All three are about what an operator SEES. None of them touches isMonitored or
-- aiAutomationEnabled, which decide whether automation works in a group — somebody tidying their
-- inbox must never be able to silently stop AI answering a live customer conversation.
--
-- Additive throughout: every column is nullable and every existing group reads as unpinned,
-- uncategorised and unarchived, which is exactly how the inbox behaved before this.

CREATE TABLE "ChatCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'gray',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatCategory_pkey" PRIMARY KEY ("id")
);

-- Unique so two people cannot create "Billing" twice and split the same groups across both.
CREATE UNIQUE INDEX "ChatCategory_name_key" ON "ChatCategory"("name");
CREATE INDEX "ChatCategory_position_idx" ON "ChatCategory"("position");

ALTER TABLE "WhatsAppGroup"
  ADD COLUMN "chatCategoryId" TEXT,
  ADD COLUMN "chatPinnedAt"   TIMESTAMP(3),
  ADD COLUMN "chatArchivedAt" TIMESTAMP(3);

CREATE INDEX "WhatsAppGroup_chatCategoryId_idx" ON "WhatsAppGroup"("chatCategoryId");

-- SET NULL, not CASCADE: deleting a category must empty it, never delete the groups in it.
ALTER TABLE "WhatsAppGroup" ADD CONSTRAINT "WhatsAppGroup_chatCategoryId_fkey"
    FOREIGN KEY ("chatCategoryId") REFERENCES "ChatCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
