import { PLATFORM_LOG_CUSTOMER } from "@support-automation/db";
import { platformPrisma } from "../db.js";
import { recordLoopTick, registerLoop } from "./loopLiveness.js";

/**
 * System Log retention (Task C, log retention). The System Log had no retention at all, so it grew for
 * ever. Deleting audit history cannot be undone, so retention is OFF unless an operator chooses a period:
 *
 *   SYSTEM_LOG_RETENTION_DAYS   unset / empty / 0 = keep everything (the default, unchanged behaviour);
 *                               otherwise a whole number of days, at least 30.
 *
 * What is never deleted, whatever the period:
 *   - scope "support": the record of every write a platform operator made through support access
 *     (SAAS_PLATFORM_PLAN.md §12) — the customer's evidence of what was done in their software;
 *   - the platform's own entries (customerId PLATFORM_LOG_CUSTOMER), which are Layer 1's audit, not a customer's.
 *
 * Deletes in batches by id (oldest first), a bounded number per tick, so a first run over years of rows
 * never holds a long lock or a long transaction.
 */

const LOOP_NAME = "system-log-retention";
export const SYSTEM_LOG_MIN_RETENTION_DAYS = 30;
export const SYSTEM_LOG_KEPT_SCOPES = ["support"] as const;
const BATCH = 5_000;
const MAX_BATCHES_PER_TICK = 10;

export type RetentionSetting = { enabled: false; reason?: string } | { enabled: true; days: number };

/** Reads the setting. Anything unclear keeps everything: a typo must never become a deletion. */
export function parseSystemLogRetention(raw: string | undefined): RetentionSetting {
  const value = (raw ?? "").trim();
  if (value === "" || value === "0") return { enabled: false };
  if (!/^\d+$/.test(value)) return { enabled: false, reason: `SYSTEM_LOG_RETENTION_DAYS="${value}" is not a whole number of days; keeping every entry.` };
  const days = Number(value);
  if (days < SYSTEM_LOG_MIN_RETENTION_DAYS) {
    return { enabled: false, reason: `SYSTEM_LOG_RETENTION_DAYS=${days} is below the ${SYSTEM_LOG_MIN_RETENTION_DAYS}-day minimum; keeping every entry.` };
  }
  return { enabled: true, days };
}

/** One pass: deletes up to MAX_BATCHES_PER_TICK batches older than the cutoff. Returns how many rows went. */
export async function pruneSystemLog(setting: RetentionSetting, now: Date = new Date()): Promise<number> {
  if (!setting.enabled) return 0;
  const cutoff = new Date(now.getTime() - setting.days * 24 * 60 * 60_000);
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
    const batch = await platformPrisma.systemLog.findMany({
      where: {
        createdAt: { lt: cutoff },
        scope: { notIn: [...SYSTEM_LOG_KEPT_SCOPES] },
        OR: [{ customerId: null }, { customerId: { not: PLATFORM_LOG_CUSTOMER } }],
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: BATCH,
    });
    if (batch.length === 0) break;
    const { count } = await platformPrisma.systemLog.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } });
    deleted += count;
    if (batch.length < BATCH) break;
  }
  return deleted;
}

export function startSystemLogRetention(intervalMs = 60 * 60_000, env: NodeJS.ProcessEnv = process.env): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  const setting = parseSystemLogRetention(env.SYSTEM_LOG_RETENTION_DAYS);
  if (!setting.enabled && setting.reason) console.warn(`[system-log-retention] ${setting.reason}`);
  if (setting.enabled) console.log(`[system-log-retention] entries older than ${setting.days} days are removed (support-access and platform entries are kept)`);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void pruneSystemLog(setting)
      .then((n) => {
        if (n > 0) console.log(`[system-log-retention] removed ${n} entries older than ${setting.enabled ? setting.days : "?"} days`);
      })
      .catch((err) => console.error("[system-log-retention] pass failed", err))
      .finally(() => {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
