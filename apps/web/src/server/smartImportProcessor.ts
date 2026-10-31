import type { Prisma } from "@prisma/client";
import { buildSmartRows, findInFileDuplicates, upgradeMapping, type ClientDuplicatePolicy, type ClientImportFieldKey, type SmartSamples } from "@support-automation/shared";
import { globalPrisma, prisma } from "@/server/db";
import { runWithProject, type ActiveProject } from "@/server/projectContext";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { loadExistingMatches } from "@/server/clientRecords";
import { loadImportLookups, resolveRows, type ResolvedImportRow } from "@/server/clientImportExtras";
import { createImportedClient, matchOf, updateImportedClient } from "@/server/clientImport";
import { logSystemEvent } from "@/server/logSystemEvent";
import { deleteStagedFile, historyCounters, readSmartCounts, SMART_KEEP_DAYS, type RowOutcome } from "@/server/smartImportJobs";
import { forgetSmartAnalysis } from "@/server/smartImport";

/**
 * The Smart Bulk Import processor (SMART_IMPORT.md §2.4). Runs in the APP process, started from
 * `instrumentation.ts` — the import's business logic lives here, and a 5,000-row import must not compete
 * with WhatsApp collection in the worker.
 *
 *   claim — one conditional update moves a QUEUED job (or a PROCESSING job whose lease ran out: a
 *           restart) to PROCESSING with a 60 s lease. Two processes cannot both hold it.
 *   batch — 25 PENDING rows. Each row is ONE transaction: advisory locks on its identifiers, a fresh
 *           look for the existing client, the client write, and the row's outcome, conditional on the
 *           row still being PENDING. A row is therefore never written twice — not by a retry, a restart
 *           or a second process.
 *   cancel — read between batches. Committed rows stay committed and are reported as such.
 */

const BATCH = 25;
const LEASE_MS = 60_000;
const TICK_MS = 3_000;
/** One tick works for at most this long, then lets the next tick (and the event loop) in. */
const TICK_BUDGET_MS = 10_000;
const SWEEP_EVERY_MS = 10 * 60_000;
const ERROR_CAP = 200;

class RowAlreadySettled extends Error {}

interface ClaimedJob {
  id: string;
  projectId: string;
}

/** Takes the oldest job that is waiting, or whose holder stopped renewing its lease. */
export async function claimSmartImportJob(now = new Date()): Promise<ClaimedJob | null> {
  const candidates = await globalPrisma.clientImportJob.findMany({
    where: { engine: "SMART", OR: [{ status: "QUEUED" }, { status: "PROCESSING", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }] },
    orderBy: [{ queuedAt: "asc" }, { createdAt: "asc" }],
    take: 5,
    select: { id: true, projectId: true, status: true, leaseUntil: true },
  });
  for (const c of candidates) {
    const won = await globalPrisma.clientImportJob.updateMany({
      where: { id: c.id, status: c.status, leaseUntil: c.leaseUntil },
      data: { status: "PROCESSING", leaseUntil: new Date(now.getTime() + LEASE_MS), startedAt: c.status === "QUEUED" ? now : undefined },
    });
    if (won.count === 1) return { id: c.id, projectId: c.projectId };
  }
  return null;
}

async function projectFor(projectId: string): Promise<ActiveProject | null> {
  const p = await globalPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, slug: true, name: true, status: true, customerId: true, billingHoldAt: true } });
  // A suspended, archived or billing-held project is read-only: its import waits, it is not failed.
  if (!p || p.status !== "ACTIVE" || p.billingHoldAt) return null;
  return { id: p.id, slug: p.slug, name: p.name, status: p.status, tenant: p.customerId };
}

/** Lets a job that cannot run now go back to waiting, so it is picked up again later. */
async function release(jobId: string): Promise<void> {
  await globalPrisma.clientImportJob.updateMany({ where: { id: jobId, status: "PROCESSING" }, data: { status: "QUEUED", leaseUntil: null } });
}

interface Plan {
  rows: Map<number, { valid?: ResolvedImportRow; errors?: string[]; repeatsRow?: number; blank?: boolean }>;
}

/** The whole file, materialised once per claim: in-file repeats need every row, not just the batch. */
async function planJob(job: { mapping: unknown }, staged: Array<{ rowNumber: number; source: unknown; edits: unknown; ignored: boolean }>): Promise<Plan> {
  const mapping = upgradeMapping(job.mapping);
  // Samples were frozen into constants at confirmation; nothing here depends on today's date or roster.
  const built = buildSmartRows(
    staged.map((r) => ({ rowNumber: r.rowNumber, source: r.source as Record<string, string>, edits: r.edits as Partial<Record<ClientImportFieldKey, string>>, ignored: r.ignored })),
    mapping,
    {} as SmartSamples,
  );
  const resolved = resolveRows(built.valid, await loadImportLookups(), { fillLocale: mapping.fillLocale !== false });
  const repeats = findInFileDuplicates(resolved.valid);
  const rows: Plan["rows"] = new Map();
  for (const r of built.blank) rows.set(r, { blank: true });
  for (const i of [...built.invalid, ...resolved.invalid]) rows.set(i.rowNumber, { errors: i.errors });
  for (const v of resolved.valid) rows.set(v.rowNumber, repeats.has(v.rowNumber) ? { repeatsRow: repeats.get(v.rowNumber) } : { valid: v });
  return { rows };
}

async function settle(rowId: string, outcome: RowOutcome, message: string | null, db: Prisma.TransactionClient | typeof prisma = prisma, clientId: string | null = null): Promise<void> {
  const r = await db.clientImportRow.updateMany({ where: { id: rowId, outcome: "PENDING" }, data: { outcome, message: message?.slice(0, 1000) ?? null, clientId, processedAt: new Date() } });
  if (r.count !== 1) throw new RowAlreadySettled();
}

/** One row's write. Locks every identifier it carries (sorted, so two imports never deadlock), then decides. */
async function writeRow(
  rowId: string,
  row: ResolvedImportRow,
  job: { projectId: string; fileName: string; duplicatePolicy: ClientDuplicatePolicy; createdById: string | null; allowSubscriptions: boolean },
): Promise<void> {
  const codes = row.fields.code ? [row.fields.code] : [];
  const lockKeys = [...new Set([...row.matchKeys, ...codes.map((c) => `code:${c.toLowerCase()}`)])].sort();
  await prisma.$transaction(
    async (tx) => {
      for (const key of lockKeys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`client-identity:${job.projectId}:${key}`}, 0))`;
      // Read again inside the locks: another import may have created this client since the plan was made.
      const { byKey, byCode } = await loadExistingMatches(row.matchKeys, codes, tx);
      const matched = matchOf(row, byKey, byCode);
      const options = { subscriptions: job.allowSubscriptions };
      if (matched && job.duplicatePolicy === "SKIP") return settle(rowId, "SKIPPED", "Matches a client you already have.", tx, matched);
      if (matched && job.duplicatePolicy === "UPDATE") {
        const outcome = await updateImportedClient(tx, matched, row, job.fileName, job.createdById, options);
        return outcome === "UPDATED" ? settle(rowId, "UPDATED", null, tx, matched) : settle(rowId, "SKIPPED", "The matching client is archived. Restore it first.", tx, matched);
      }
      const clientId = await createImportedClient(tx, row, job.fileName, job.createdById, options);
      return settle(rowId, "CREATED", null, tx, clientId);
    },
    { timeout: 30_000 },
  );
}

async function finish(jobId: string, cancelled: boolean): Promise<void> {
  const counts = await readSmartCounts(jobId);
  const problems = await prisma.clientImportRow.findMany({
    where: { jobId, outcome: { in: ["INVALID", "FAILED"] } },
    orderBy: { rowNumber: "asc" },
    take: ERROR_CAP,
    select: { rowNumber: true, message: true },
  });
  const written = counts.created + counts.updated;
  const status = cancelled ? "CANCELLED" : counts.invalid + counts.failed === 0 ? "COMPLETED" : written === 0 ? "FAILED" : "PARTIAL";
  const job = await prisma.clientImportJob.update({
    where: { id: jobId },
    data: {
      status,
      ...historyCounters(counts),
      errors: problems.map((p) => ({ rowNumber: p.rowNumber, errors: [p.message ?? "The row could not be saved."] })),
      completedAt: new Date(),
      leaseUntil: null,
      cancelRequestedAt: null,
      expiresAt: new Date(Date.now() + SMART_KEEP_DAYS * 86_400_000),
    },
    select: { fileName: true, createdById: true },
  });
  forgetSmartAnalysis(jobId);
  await logSystemEvent(
    "INFO",
    "clients",
    `Smart import ${status.toLowerCase()}: ${counts.created} created, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.invalid + counts.failed} not imported${cancelled ? `, ${counts.pending} not attempted` : ""}`,
    { jobId, fileName: job.fileName, ...counts },
    { actorUserId: job.createdById, targetType: "ClientImportJob", targetId: jobId },
  );
}

/** Works on one claimed job until its rows are done, it is cancelled, or the tick's time is up. */
export async function processClaimedJob(jobId: string, budgetMs = TICK_BUDGET_MS): Promise<"DONE" | "CANCELLED" | "MORE"> {
  const started = Date.now();
  const job = await prisma.clientImportJob.findFirstOrThrow({
    where: { id: jobId },
    select: { id: true, projectId: true, fileName: true, mapping: true, duplicatePolicy: true, createdById: true, allowSubscriptions: true, cancelRequestedAt: true },
  });
  if (job.cancelRequestedAt) {
    await finish(jobId, true);
    return "CANCELLED";
  }
  const staged = await prisma.clientImportRow.findMany({ where: { jobId }, select: { id: true, rowNumber: true, source: true, edits: true, ignored: true, outcome: true } });
  const plan = await planJob(job, staged);

  for (;;) {
    const batch = await prisma.clientImportRow.findMany({ where: { jobId, outcome: "PENDING" }, orderBy: { rowNumber: "asc" }, take: BATCH, select: { id: true, rowNumber: true } });
    if (batch.length === 0) {
      await finish(jobId, false);
      return "DONE";
    }
    for (const row of batch) {
      const p = plan.rows.get(row.rowNumber);
      try {
        if (!p || p.blank) await settle(row.id, "SKIPPED", "Empty row.");
        else if (p.errors) await settle(row.id, "INVALID", p.errors.join(" "));
        else if (p.repeatsRow !== undefined) await settle(row.id, "SKIPPED", `Repeats row ${p.repeatsRow} of this file.`);
        else await writeRow(row.id, p.valid!, job);
      } catch (err) {
        if (err instanceof RowAlreadySettled) continue;
        // The error's type only: a database error can carry the values of the row it failed on.
        console.error("[clients] smart import row failed", (err as { code?: string }).code ?? (err as Error).name);
        await settle(row.id, "FAILED", isUniqueViolation(err) ? "That client code is already used by another client." : "The row could not be saved.").catch(() => undefined);
      }
    }
    const counts = await readSmartCounts(jobId);
    const renewed = await prisma.clientImportJob.updateMany({
      where: { id: jobId, status: "PROCESSING" },
      data: { leaseUntil: new Date(Date.now() + LEASE_MS), ...historyCounters(counts) },
    });
    if (renewed.count !== 1) return "MORE"; // somebody else holds it now; stop touching it
    forgetSmartAnalysis(jobId);
    const fresh = await prisma.clientImportJob.findFirst({ where: { id: jobId }, select: { cancelRequestedAt: true } });
    if (fresh?.cancelRequestedAt) {
      await finish(jobId, true);
      return "CANCELLED";
    }
    if (Date.now() - started > budgetMs) return "MORE";
  }
}

/** Drafts nobody confirmed, and finished imports' staged rows, after their time is up. */
export async function sweepSmartImports(now = new Date()): Promise<void> {
  const due = await globalPrisma.clientImportJob.findMany({
    where: { engine: "SMART", expiresAt: { lt: now }, status: { in: ["PREVIEW", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED"] } },
    take: 50,
    select: { id: true, projectId: true, status: true, stagingKey: true },
  });
  for (const job of due) {
    const project = await globalPrisma.project.findUnique({ where: { id: job.projectId }, select: { id: true, slug: true, name: true, status: true, customerId: true } });
    if (!project) continue;
    await runWithProject({ id: project.id, slug: project.slug, name: project.name, status: project.status, tenant: project.customerId }, async () => {
      await prisma.clientImportRow.deleteMany({ where: { jobId: job.id } });
      await prisma.clientImportJob.update({
        where: { id: job.id },
        data: job.status === "PREVIEW" ? { status: "EXPIRED", expiresAt: null, stagingKey: null, completedAt: now } : { expiresAt: null, stagingKey: null },
      });
    });
    await deleteStagedFile(job.stagingKey);
  }
}

let running = false;
let lastSweep = 0;

/** One tick: maybe a sweep, then at most one job for at most the tick's budget. Never throws. */
export async function smartImportTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
      lastSweep = Date.now();
      await sweepSmartImports().catch((err) => console.error("[clients] smart import sweep failed", (err as Error).name));
    }
    const claimed = await claimSmartImportJob();
    if (!claimed) return;
    const project = await projectFor(claimed.projectId);
    if (!project) {
      await release(claimed.id);
      return;
    }
    await runWithProject(project, () => processClaimedJob(claimed.id));
  } catch (err) {
    console.error("[clients] smart import tick failed", (err as { code?: string }).code ?? (err as Error).name);
  } finally {
    running = false;
  }
}

declare global {
  var __smartImportTimer: ReturnType<typeof setInterval> | undefined;
}

/** Started once per server process from instrumentation.ts. */
export function startSmartImportProcessor(): void {
  if (globalThis.__smartImportTimer) return;
  globalThis.__smartImportTimer = setInterval(() => void smartImportTick(), TICK_MS);
  globalThis.__smartImportTimer.unref?.();
  console.log("[clients] smart import processor started");
}
