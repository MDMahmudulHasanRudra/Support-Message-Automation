-- Per-loop liveness, readable by the dashboard.
--
-- The worker's heartbeat proves that ONE setInterval fires. It shares nothing with the other
-- twenty loops — not a lock, not a queue, not a counter — so "the worker is alive" has always
-- meant exactly "the heartbeat's own timer is still scheduled", and that stays true while the
-- outbound queue, the command processor or the registry sync sits wedged on a call into a browser
-- that never answers. Each is an overlap-guarded loop whose guard, once stuck, silently turns
-- every later tick into a no-op, with nothing anywhere to say so.
--
-- The worker tracks this in memory. This row exists only because the dashboard cannot ask it:
-- there is no HTTP between the two by design, so Postgres is the channel — the same one that
-- already carries account status and WorkerCommand.
--
-- One singleton row, written once per heartbeat rather than once per tick. The command processor
-- runs every 1.5 seconds; a write per tick would be tens of thousands of rows a day to report that
-- nothing is wrong.

-- CreateTable
CREATE TABLE "WorkerHealthSnapshot" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "loops" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerHealthSnapshot_pkey" PRIMARY KEY ("id")
);
