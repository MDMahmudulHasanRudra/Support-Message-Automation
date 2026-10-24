import { NextResponse, type NextRequest } from "next/server";
import { autoMapColumns, CLIENT_IMPORT_FIELDS, type ClientImportMapping } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { contentDisposition } from "@/server/reports/exportFile";
import { listImportProblems, type RawImportRow } from "@/server/clientImport";
import { buildWorkbook, columnLetter, type Cell } from "@/server/xlsxWriter";
import { IMPORT_TEMPLATE_COLUMNS } from "@/server/clientImportTemplate";
import { analyzeSmartJob, smartImportEnabled } from "@/server/smartImport";

/**
 * "Download problem rows" on an import preview (CLIENTS_V3.md §Import): every row the import would
 * refuse, with the file's OWN columns in the file's own order plus a "Problem" column saying why. Fix
 * the rows, upload this file, and only they are imported — the Problem column is not a client field, so
 * it is ignored. Available only while the job is a preview: the file's rows are deleted when it ends.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  await requireAccess("clients.import");
  const { jobId } = await params;
  const job = await prisma.clientImportJob.findFirst({ where: { id: jobId }, select: { status: true, rows: true, mapping: true, fileName: true, engine: true } });
  if (!job) return NextResponse.json({ error: "That import no longer exists." }, { status: 404 });
  if (job.engine === "SMART") return smartProblems(jobId, job.fileName);
  if (job.status !== "PREVIEW") return NextResponse.json({ error: "Problem rows can be downloaded only before the import is confirmed; the file's rows are not kept afterwards." }, { status: 409 });
  const rows = job.rows as unknown as RawImportRow[];
  // The stored rows are jsonb, which does not keep the file's column order. Put the columns back in
  // the template's order, then any other mapped field in field order, then the rest by name.
  const mapping = job.mapping as Record<string, string>;
  // A mapped column takes the place of the field it fills in the template; an unmapped one goes last.
  const templateHeaders = IMPORT_TEMPLATE_COLUMNS.map((c) => c.header);
  const templateFieldHeader = autoMapColumns(templateHeaders) as Record<string, string>;
  const fieldOf = new Map(CLIENT_IMPORT_FIELDS.filter((f) => mapping[f.key]).map((f) => [mapping[f.key]!, f.key]));
  const rank = (h: string) => {
    const field = fieldOf.get(h);
    const at = field ? templateHeaders.indexOf(templateFieldHeader[field] ?? "") : -1;
    return at >= 0 ? at : 1000;
  };
  const headers = Object.keys(rows[0] ?? {}).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const problems = await listImportProblems(rows, mapping as ClientImportMapping);
  const header: Cell[] = [{ value: "Problem", style: "headerRequired" }, ...headers.map((h) => ({ value: h, style: "header" as const }))];
  const body = problems.map((p) => {
    const raw = rows[p.rowNumber - 2] ?? {};
    return [{ value: `Row ${p.rowNumber}: ${p.errors.join(" ")}`, style: "wrap" as const }, ...headers.map((h) => ({ value: raw[h] ?? "", style: "text" as const }))];
  });
  const bytes = buildWorkbook(
    [
      {
        name: "Problem rows",
        rows: [header, ...body],
        widths: [60, ...headers.map((h) => Math.min(40, Math.max(12, h.length + 4)))],
        columnStyles: [undefined, ...headers.map(() => "text" as const)],
        freezeRows: 1,
        freezeCols: 1,
        headerHeight: 30,
        autoFilter: `A1:${columnLetter(headers.length)}${body.length + 1}`,
      },
    ],
    "Problem rows",
  );
  const base = job.fileName.replace(/\.(xlsx|csv)$/i, "").slice(0, 80) || "clients";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`${base}-problem-rows.xlsx`),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Smart Bulk Import (SMART_IMPORT.md): before the import, the rows the check refuses; after it, the rows
 * that were not imported — each with its reason, in the file's own columns and order. Cells are written
 * as text, never as formulas.
 */
async function smartProblems(jobId: string, fileName: string) {
  if (!(await smartImportEnabled())) return NextResponse.json({ error: "Smart Bulk Import is not switched on for this project." }, { status: 403 });
  const job = await prisma.clientImportJob.findFirstOrThrow({ where: { id: jobId }, select: { id: true, status: true, revision: true, mapping: true, headers: true, blankHeaders: true, duplicateHeaders: true } });
  let problems: Array<{ rowNumber: number; reason: string; rowId: string }>;
  if (job.status === "PREVIEW") {
    const analysis = await analyzeSmartJob(job);
    problems = analysis.rows.filter((r) => r.status === "INVALID").map((r) => ({ rowNumber: r.rowNumber, reason: r.errors.join(" "), rowId: r.id }));
  } else {
    const rows = await prisma.clientImportRow.findMany({ where: { jobId, outcome: { in: ["INVALID", "FAILED"] } }, orderBy: { rowNumber: "asc" }, select: { id: true, rowNumber: true, message: true } });
    problems = rows.map((r) => ({ rowNumber: r.rowNumber, reason: r.message ?? "The row could not be saved.", rowId: r.id }));
  }
  if (!problems.length && job.status !== "PREVIEW") return NextResponse.json({ error: "No rows are left to download: they were imported, or the file's rows were deleted after 7 days." }, { status: 404 });
  const sources = await prisma.clientImportRow.findMany({ where: { jobId, id: { in: problems.map((p) => p.rowId) } }, select: { id: true, source: true, edits: true } });
  const byId = new Map(sources.map((s) => [s.id, s]));
  const headers = job.headers;
  const header: Cell[] = [{ value: "Problem", style: "headerRequired" }, ...headers.map((h) => ({ value: h, style: "header" as const }))];
  const body = problems.map((p) => {
    const src = (byId.get(p.rowId)?.source ?? {}) as Record<string, string>;
    return [{ value: `Row ${p.rowNumber}: ${p.reason}`, style: "wrap" as const }, ...headers.map((h) => ({ value: src[h] ?? "", style: "text" as const }))];
  });
  const bytes = buildWorkbook(
    [{ name: "Problem rows", rows: [header, ...body], widths: [60, ...headers.map((h) => Math.min(40, Math.max(12, h.length + 4)))], columnStyles: [undefined, ...headers.map(() => "text" as const)], freezeRows: 1, freezeCols: 1, headerHeight: 30, autoFilter: `A1:${columnLetter(headers.length)}${body.length + 1}` }],
    "Problem rows",
  );
  const base = fileName.replace(/\.(xlsx|csv)$/i, "").slice(0, 80) || "clients";
  return new NextResponse(new Uint8Array(bytes), {
    headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": contentDisposition(`${base}-problem-rows.xlsx`), "Cache-Control": "no-store" },
  });
}
