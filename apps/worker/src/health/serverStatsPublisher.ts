import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { platformPrisma } from "../db.js";
import { collectProcessStats, type ProcessStats } from "./serverStats.js";

/**
 * Publishes serverStats.ts's reading for Platform → Monitoring, at most once a minute (P1-08, doc 20 O5).
 *
 * Written as a SECOND row of `WorkerHealthSnapshot` (id "process"; its `loops` column holds the reading),
 * not a new column: every existing reader asks for id "global" and is untouched, and no migration is needed
 * — so this cannot become the code-ahead-of-its-migration failure (CLAUDE.md, the P2022 incident).
 *
 * Runs beside the heartbeat, never inside it: its own overlap guard, its own failures. A slow `/proc` scan
 * must not delay the liveness stamp the dashboard reads.
 */
const EVERY_MS = 60_000;
let running = false;
let lastStartedAt = 0;
let latest: ProcessStats | null = null;

export function readLatestProcessStats(): ProcessStats | null {
  return latest;
}

export function maybePublishProcessStats(startedAt: number): void {
  if (running || Date.now() - lastStartedAt < EVERY_MS) return;
  running = true;
  lastStartedAt = Date.now();
  void (async () => {
    const accounts = await platformPrisma.whatsAppAccount.findMany({
      where: { sessionDataPath: { not: null }, sessionId: { not: null } },
      select: { id: true, sessionDataPath: true, sessionId: true },
    });
    // The exact profile path OpenWAProvider launches Chromium with (and orphanBrowsers.ts kills by).
    const profiles = new Map(accounts.map((a) => [join(a.sessionDataPath!, `_IGNORE_${a.sessionId!}`), a.id]));
    const stats = await collectProcessStats(profiles);
    latest = stats;
    const loops = stats as unknown as Prisma.InputJsonValue;
    await platformPrisma.workerHealthSnapshot.upsert({
      where: { id: "process" },
      update: { loops, startedAt: new Date(startedAt) },
      create: { id: "process", loops, startedAt: new Date(startedAt) },
    });
  })()
    .catch((err) => console.error("[worker] process figures could not be published", err))
    .finally(() => {
      running = false;
    });
}
