import type { BrowserUsage } from "../WhatsAppProvider.js";

/**
 * Reduces what OpenWA's `client.getProcessStats()` returns — `pidusage`'s map of pid to
 * `{ cpu, memory, … }` for this process tree and the browser's — to one figure. Pure and defensive:
 * a library that changes the shape, a missing field or a non-number is "unknown" (null), never a
 * throw and never a made-up zero.
 */
export function summariseProcessStats(stats: unknown): BrowserUsage | null {
  if (!stats || typeof stats !== "object") return null;
  let cpuPercent = 0;
  let memoryBytes = 0;
  let processes = 0;
  for (const entry of Object.values(stats as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { cpu, memory } = entry as { cpu?: unknown; memory?: unknown };
    if (typeof cpu !== "number" || !Number.isFinite(cpu)) continue;
    cpuPercent += cpu;
    if (typeof memory === "number" && Number.isFinite(memory)) memoryBytes += memory;
    processes += 1;
  }
  return processes > 0 ? { cpuPercent, memoryBytes, processes } : null;
}
