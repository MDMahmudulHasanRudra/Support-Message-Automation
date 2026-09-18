-- A durable count of messages that were received and stored nowhere.
--
-- The 18 Sep 2026 outage could not answer its own first question — did messages arrive and get
-- discarded, or never arrive at all? A dropped message leaves no row anywhere, and the in-memory
-- `received` counter resets on the restart that is always the first thing tried, so both halves
-- were unanswerable at exactly the moment they mattered.
--
-- A counter rather than a row per message: the failure worth catching is a change in SHAPE (a
-- WhatsApp update that starts delivering ordinary text in a form this code reads as empty), which
-- shows up as a spike in a daily number. One row each would be a second unbounded message table
-- holding the messages this system understood least. It also makes "received" derivable at last:
-- received = stored + dropped.

-- CreateEnum
CREATE TYPE "MessageDropReason" AS ENUM ('EMPTY_BODY', 'PIPELINE_ERROR');

-- CreateTable
CREATE TABLE "MessageDropCounter" (
    "accountId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "reason" "MessageDropReason" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageDropCounter_pkey" PRIMARY KEY ("accountId","day","reason")
);

-- CreateIndex
CREATE INDEX "MessageDropCounter_day_idx" ON "MessageDropCounter"("day");

-- AddForeignKey
ALTER TABLE "MessageDropCounter" ADD CONSTRAINT "MessageDropCounter_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
