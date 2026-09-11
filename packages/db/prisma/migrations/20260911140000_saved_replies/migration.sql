-- Replies an operator sends often enough to be worth keeping.
--
-- Separate from AiKnowledgeItem on purpose: that table is what the assistant answers customers
-- from and carries a verification gate for exactly that reason. This is shorthand a person picks
-- and sends themselves, and mixing the two would put unreviewed shorthand into the assistant's
-- mouth while putting customer-facing claims into a list people edit casually.
CREATE TABLE "SavedReply" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SavedReply_position_idx" ON "SavedReply"("position");

ALTER TABLE "SavedReply" ADD CONSTRAINT "SavedReply_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
