import { prisma } from "@/server/db";
import { getMediaStorage } from "@/server/mediaStorage";

/**
 * Smart Bulk Import job bookkeeping shared by the actions and the background processor
 * (SMART_IMPORT.md). Counts are always read from the staged rows, so what a page shows is the
 * database's own count, never an estimate.
 */

/** A draft nobody confirms within this many days expires; a finished import's staged rows are kept this long. */
export const SMART_DRAFT_DAYS = 7;
export const SMART_KEEP_DAYS = 7;

export const smartStagingKey = (projectId: string, jobId: string) => `imports/${projectId}/${jobId}`;

export type RowOutcome = "PENDING" | "CREATED" | "UPDATED" | "SKIPPED" | "INVALID" | "FAILED" | "IGNORED";

export interface SmartCounts {
  total: number;
  pending: number;
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  failed: number;
  ignored: number;
  /** Rows that reached a final outcome. */
  done: number;
}

export async function readSmartCounts(jobId: string): Promise<SmartCounts> {
  const groups = await prisma.clientImportRow.groupBy({ by: ["outcome"], where: { jobId }, _count: { _all: true } });
  const n = (o: RowOutcome) => groups.find((g) => g.outcome === o)?._count._all ?? 0;
  const total = groups.reduce((s, g) => s + g._count._all, 0);
  const counts = { total, pending: n("PENDING"), created: n("CREATED"), updated: n("UPDATED"), skipped: n("SKIPPED"), invalid: n("INVALID"), failed: n("FAILED"), ignored: n("IGNORED") };
  return { ...counts, done: counts.created + counts.updated + counts.skipped + counts.invalid + counts.failed + counts.ignored };
}

/** The history row's counters, from the rows: skipped includes rows the person ignored; failed includes invalid ones. */
export function historyCounters(c: SmartCounts) {
  return { importedCount: c.created, updatedCount: c.updated, skippedCount: c.skipped + c.ignored, failedCount: c.invalid + c.failed };
}

/** Removes the privately kept upload. A missing file is not an error. */
export async function deleteStagedFile(stagingKey: string | null): Promise<void> {
  if (!stagingKey) return;
  try {
    await getMediaStorage()?.delete(stagingKey);
  } catch (err) {
    console.error("[clients] smart import: could not delete a staged file", (err as Error).name);
  }
}
