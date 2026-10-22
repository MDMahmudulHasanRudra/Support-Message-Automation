"use server";

import { importOptionsFor } from "@/server/clientImportExtras";
import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import {
  autoMapColumns,
  CLIENT_DUPLICATE_POLICIES,
  CLIENT_IMPORT_FIELDS,
  MAX_CLIENT_IMPORT_BYTES,
  MAX_CLIENT_IMPORT_ROWS,
  type ClientDuplicatePolicy,
  type ClientImportMapping,
} from "@support-automation/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { processImportRows, type RawImportRow } from "@/server/clientImport";
import { canDeleteClientRecords } from "@/server/clientModule";
import { DELETE_REFUSED } from "@/lib/clientDeleteRule";

/**
 * Client import: upload → preview with column mapping → confirm → final report. Every step makes its
 * own `clients.import` check. Nothing is created until the confirmation, and the confirmation is
 * claimed with one conditional update, so pressing it twice (or from two tabs) imports once.
 */

export interface ClientImportFormState {
  error?: string;
  jobId?: string;
}

export interface ClientImportActionResult {
  ok: boolean;
  message: string;
}

const MAX_COLUMNS = 60;
const MAX_CELL = 1000;
const MAX_TOTAL_CHARS = 4_000_000;
const FIELD_KEYS = CLIENT_IMPORT_FIELDS.map((f) => f.key) as string[];

async function refresh(jobId?: string) {
  revalidatePath(await projectPath("/clients/import"));
  if (jobId) revalidatePath(await projectPath(`/clients/import/${jobId}`));
  revalidatePath(await projectPath("/clients"));
}

/** A sheet as header names and text rows. Cells are text on purpose: a phone number must keep its leading zero. */
function readSheet(buffer: Buffer, isCsv: boolean): { headers: string[]; rows: RawImportRow[] } | { error: string } {
  let workbook: XLSX.WorkBook;
  // `sheetRows` stops the parser at the row limit instead of expanding the whole sheet: a small
  // compressed .xlsx can hold far more than 2 MB of cells, and its size on disk says nothing about it.
  const parseLimit = { sheetRows: MAX_CLIENT_IMPORT_ROWS + 2, cellFormula: false, cellHTML: false, cellStyles: false };
  try {
    workbook = isCsv
      ? XLSX.read(new TextDecoder("utf-8").decode(buffer), { type: "string", raw: true, ...parseLimit })
      : XLSX.read(buffer, { type: "buffer", ...parseLimit });
  } catch {
    return { error: "That file could not be read. Save it as .xlsx or .csv and try again." };
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!sheet) return { error: "The file has no sheet to read." };
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
  if (range.e.c - range.s.c + 1 > MAX_COLUMNS * 4) return { error: `That sheet has too many columns (more than ${MAX_COLUMNS * 4}).` };
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false });
  if (grid.length < 2) return { error: "The file needs a header row and at least one client row." };

  const seen = new Map<string, number>();
  const headers = (grid[0] ?? []).slice(0, MAX_COLUMNS).map((h, i) => {
    const base = String(h ?? "").trim().slice(0, 80) || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  let totalChars = 0;
  const rows = grid.slice(1).map((cells) => {
    const record: RawImportRow = {};
    headers.forEach((header, i) => {
      const value = String(cells[i] ?? "").trim().slice(0, MAX_CELL);
      totalChars += value.length;
      record[header] = value;
    });
    return record;
  });
  // What is stored on the job is the text itself, so it is bounded as text — not by the file's size.
  if (totalChars > MAX_TOTAL_CHARS) return { error: "The file holds too much text for one import. Split it into smaller files." };
  return { headers, rows };
}

export async function previewClientImport(_prev: ClientImportFormState, formData: FormData): Promise<ClientImportFormState> {
  const granted = await checkPermission("clients.import");
  if ("denied" in granted) return { error: granted.denied };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a .csv or .xlsx file first." };
  const name = file.name || "clients";
  const lower = name.toLowerCase();
  const isCsv = lower.endsWith(".csv");
  if (!isCsv && !lower.endsWith(".xlsx")) return { error: "Only .csv and .xlsx files can be imported." };
  if (file.size > MAX_CLIENT_IMPORT_BYTES) return { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_CLIENT_IMPORT_BYTES / 1024 / 1024} MB.` };

  const sheet = readSheet(Buffer.from(await file.arrayBuffer()), isCsv);
  if ("error" in sheet) return { error: sheet.error };
  if (sheet.rows.length > MAX_CLIENT_IMPORT_ROWS) {
    return { error: `That file has more than ${MAX_CLIENT_IMPORT_ROWS.toLocaleString()} rows. One import takes at most ${MAX_CLIENT_IMPORT_ROWS.toLocaleString()}; split the file and import it in parts.` };
  }

  const mapping = autoMapColumns(sheet.headers);
  const job = await prisma.clientImportJob.create({
    data: {
      createdById: granted.session.userId,
      fileName: name.slice(0, 200),
      fileType: isCsv ? "csv" : "xlsx",
      status: "PREVIEW",
      mapping: mapping as Prisma.InputJsonValue,
      rows: sheet.rows as unknown as Prisma.InputJsonValue,
      totalRows: sheet.rows.length,
    },
    select: { id: true },
  });
  await refresh();
  return { jobId: job.id };
}

/** Changes which column is which field while the job is still a preview. */
export async function remapClientImport(jobId: string, mapping: Record<string, string>): Promise<ClientImportActionResult> {
  const granted = await checkPermission("clients.import");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const job = await prisma.clientImportJob.findFirst({ where: { id: jobId }, select: { status: true, rows: true } });
  if (!job || job.status !== "PREVIEW") return { ok: false, message: "This import can no longer be changed." };
  const headers = new Set(Object.keys(((job.rows as unknown as RawImportRow[])[0] ?? {})));
  const clean: ClientImportMapping = {};
  const used = new Set<string>();
  for (const [field, column] of Object.entries(mapping ?? {})) {
    if (!FIELD_KEYS.includes(field) || !column) continue;
    if (!headers.has(column)) return { ok: false, message: `The file has no column called "${column.slice(0, 40)}".` };
    if (used.has(column)) return { ok: false, message: `The column "${column.slice(0, 40)}" is mapped to two fields.` };
    used.add(column);
    (clean as Record<string, string>)[field] = column;
  }
  await prisma.clientImportJob.update({ where: { id: jobId }, data: { mapping: clean as Prisma.InputJsonValue } });
  await refresh(jobId);
  return { ok: true, message: "Mapping saved." };
}

export async function confirmClientImport(jobId: string, policy: string): Promise<ClientImportActionResult> {
  const granted = await checkPermission("clients.import");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  if (!(CLIENT_DUPLICATE_POLICIES as readonly string[]).includes(policy)) return { ok: false, message: "Choose what to do with rows that match an existing client." };

  // One claim, however many times and from however many tabs this is pressed.
  const claim = await prisma.clientImportJob.updateMany({
    where: { id: jobId, status: "PREVIEW" },
    data: { status: "PROCESSING", duplicatePolicy: policy as ClientDuplicatePolicy, startedAt: new Date() },
  });
  if (claim.count !== 1) return { ok: false, message: "This import has already been started or is no longer available." };

  const job = await prisma.clientImportJob.findFirstOrThrow({ where: { id: jobId } });
  const mapping = job.mapping as ClientImportMapping;
  if (!mapping.name) {
    await prisma.clientImportJob.update({ where: { id: jobId }, data: { status: "PREVIEW", startedAt: null } });
    return { ok: false, message: "Map a column to Name first — every client needs one." };
  }

  const importOptions = await importOptionsFor(granted.session);
  let result: Awaited<ReturnType<typeof processImportRows>>;
  try {
    result = await processImportRows(job.rows as unknown as RawImportRow[], mapping, policy as ClientDuplicatePolicy, job.fileName, granted.session.userId, async (partial) => {
      await prisma.clientImportJob.update({
        where: { id: jobId },
        data: { importedCount: partial.imported, updatedCount: partial.updated, skippedCount: partial.skipped, failedCount: partial.failed },
      });
    }, importOptions);
  } catch (err) {
    // The error type and code only: a database error can carry the values of the row it failed on.
    console.error("[clients] import failed", (err as { code?: string; name?: string }).code ?? (err as Error).name);
    await prisma.clientImportJob.update({ where: { id: jobId }, data: { status: "FAILED", rows: [], completedAt: new Date(), errors: [{ rowNumber: 0, errors: ["The import stopped unexpectedly. Rows already imported are kept; re-upload with Skip or Update to finish."] }] } });
    await refresh(jobId);
    return { ok: false, message: "The import stopped unexpectedly. Rows already imported are kept." };
  }

  const status = result.failed === 0 ? "COMPLETED" : result.imported + result.updated === 0 ? "FAILED" : "PARTIAL";
  await prisma.clientImportJob.update({
    where: { id: jobId },
    data: {
      status,
      importedCount: result.imported,
      updatedCount: result.updated,
      skippedCount: result.skipped,
      failedCount: result.failed,
      validRows: result.imported + result.updated + result.skipped,
      invalidRows: result.failed,
      errors: result.errors,
      rows: [], // personal data with no reason to stay once the import is over
      completedAt: new Date(),
    },
  });
  // The record that it happened: counts and the file's name, never the clients.
  await logSystemEvent("INFO", "clients", `Client import finished: ${result.imported} created, ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed`, { jobId, fileName: job.fileName, policy, ...result, errors: undefined }, { actorUserId: granted.session.userId, targetType: "ClientImportJob", targetId: jobId });
  await refresh(jobId);
  return { ok: true, message: `Imported ${result.imported}, updated ${result.updated}, skipped ${result.skipped}, failed ${result.failed}.` };
}

/** Drops a preview that will not be imported, and the file's rows with it. */
export async function cancelClientImport(jobId: string): Promise<ClientImportActionResult> {
  const granted = await checkPermission("clients.import");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const r = await prisma.clientImportJob.updateMany({ where: { id: jobId, status: "PREVIEW" }, data: { status: "CANCELLED", rows: [], completedAt: new Date() } });
  await refresh(jobId);
  return r.count === 1 ? { ok: true, message: "Import cancelled. Nothing was imported." } : { ok: false, message: "This import is no longer a preview." };
}

/** Closes an import a restart left PROCESSING, so it stops looking like it is still running. */
export async function abandonClientImport(jobId: string): Promise<ClientImportActionResult> {
  const granted = await checkPermission("clients.import");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const stale = new Date(Date.now() - 10 * 60_000);
  const r = await prisma.clientImportJob.updateMany({
    where: { id: jobId, status: "PROCESSING", startedAt: { lt: stale } },
    data: { status: "FAILED", rows: [], completedAt: new Date(), errors: [{ rowNumber: 0, errors: ["Closed by hand: the import was interrupted. Clients already imported are kept; re-upload with Skip or Update to finish."] }] },
  });
  await refresh(jobId);
  return r.count === 1 ? { ok: true, message: "Marked as failed." } : { ok: false, message: "Only an import that has been running for over 10 minutes can be closed." };
}

/**
 * Clears import HISTORY (rows on the Import Clients page). Clients an import created or updated are
 * never touched — only the record of the import goes. Clearing is a delete, so it follows the Clients
 * delete rule: an Administrator, or a role an Administrator gave clients.delete. An import still
 * running is never cleared, nor a preview younger than a day (somebody may be reviewing it).
 * `ids` = these rows; "finished" = every clearable row.
 */
export async function clearClientImports(ids: string[] | "finished"): Promise<ClientImportActionResult> {
  const granted = await checkPermission("clients.import");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  if (!(await canDeleteClientRecords(granted.session))) return { ok: false, message: DELETE_REFUSED };
  if (ids !== "finished" && (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || ids.some((id) => typeof id !== "string"))) {
    return { ok: false, message: "Choose the imports to clear." };
  }
  const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
  const clearable: Prisma.ClientImportJobWhereInput = {
    OR: [{ status: { in: ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"] } }, { status: "PREVIEW", createdAt: { lt: dayAgo } }],
  };
  const where: Prisma.ClientImportJobWhereInput = ids === "finished" ? clearable : { AND: [{ id: { in: ids } }, clearable] };
  const removed = await prisma.clientImportJob.deleteMany({ where });
  if (removed.count) {
    await logSystemEvent("INFO", "clients", `Cleared ${removed.count} import history row(s)`, { count: removed.count, how: ids === "finished" ? "all finished" : "selected" }, { actorUserId: granted.session.userId, targetType: "ClientImportJob" });
  }
  await refresh();
  const kept = ids === "finished" ? 0 : ids.length - removed.count;
  if (!removed.count) return { ok: false, message: kept ? "Nothing cleared: an import still running, or a preview from today, is kept." : "Nothing to clear." };
  const keptNote = kept ? ` (${kept} kept: still running, or a preview from today)` : "";
  return { ok: true, message: `Cleared ${removed.count} import${removed.count === 1 ? "" : "s"} from the history${keptNote}. The clients they imported are not affected.` };
}
