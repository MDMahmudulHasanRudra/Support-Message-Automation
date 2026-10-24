import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { autoMapSmart, SMART_IMPORT_LIMITS } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { logSystemEvent } from "@/server/logSystemEvent";
import { getMediaStorage } from "@/server/mediaStorage";
import { parseUpload, SMART_IMPORT_OFF, smartImportEnabled } from "@/server/smartImport";
import { SMART_DRAFT_DAYS, smartStagingKey } from "@/server/smartImportJobs";

/**
 * Smart Bulk Import upload (SMART_IMPORT.md). A Route Handler, not a Server Action: a 15 MB file with
 * upload progress, bounded here rather than by raising every action's body limit.
 *
 * session → `clients.import` with Client Management → CLIENT_SMART_IMPORT → size → type → (xlsx) the zip
 * directory → parse with row/column/cell limits → ONE transaction: the job and its staged rows. Nothing
 * is imported here; the response is the draft's id. The file's values are never logged.
 */
export const dynamic = "force-dynamic";

const refuse = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } });

/** Workbooks are read in this process; at most two at a time so a burst of uploads cannot starve it. */
let reading = 0;
const MAX_CONCURRENT_READS = 2;

export async function POST(request: NextRequest) {
  if (!(await getSession())) return refuse(401, "Sign in again to upload.");
  const access = await checkPermission("clients.import", "CLIENT_CENTER");
  if ("denied" in access) return refuse(403, access.denied);
  if (!(await smartImportEnabled())) return refuse(403, SMART_IMPORT_OFF);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > SMART_IMPORT_LIMITS.maxBytes + 256 * 1024) {
    return refuse(413, `That file is larger than ${SMART_IMPORT_LIMITS.maxBytes / 1024 / 1024} MB. Split it into smaller files.`);
  }
  if (reading >= MAX_CONCURRENT_READS) return refuse(429, "Other files are being read right now. Try again in a few seconds.");
  reading += 1;
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return refuse(400, "The file did not arrive completely. Try again.");
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return refuse(400, "Choose a .xlsx or .csv file.");
    if (file.size > SMART_IMPORT_LIMITS.maxBytes) return refuse(413, `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${SMART_IMPORT_LIMITS.maxBytes / 1024 / 1024} MB.`);
    const fileName = (file.name || "clients").replace(/[\\/\u0000-\u001f]/g, "").slice(0, 200) || "clients";
    const buffer = Buffer.from(await file.arrayBuffer());

    const started = Date.now();
    const parsed = parseUpload(buffer, fileName);
    if ("error" in parsed) return refuse(422, parsed.error);
    const { records } = parsed;

    const projectId = await activeProjectId();
    const userId = access.session.userId;
    const job = await prisma.$transaction(
      async (tx) => {
        const created = await tx.clientImportJob.create({
          data: {
            engine: "SMART",
            status: "PREVIEW",
            createdById: userId,
            fileName,
            fileType: fileName.toLowerCase().endsWith(".csv") ? "csv" : "xlsx",
            fileSize: buffer.length,
            sheetName: parsed.sheetName,
            sheetNames: parsed.sheetNames,
            headerRow: parsed.headerRow,
            headers: records.headers,
            blankHeaders: records.blankHeaders,
            duplicateHeaders: records.duplicateHeaders,
            mapping: autoMapSmart(records.headers).mapping as unknown as Prisma.InputJsonValue,
            totalRows: records.rows.length,
            expiresAt: new Date(Date.now() + SMART_DRAFT_DAYS * 86_400_000),
          },
          select: { id: true },
        });
        for (let i = 0; i < records.rows.length; i += 1000) {
          await tx.clientImportRow.createMany({
            data: records.rows.slice(i, i + 1000).map((r) => ({ jobId: created.id, rowNumber: r.rowNumber, source: r.cells })),
          });
        }
        return created;
      },
      { timeout: 60_000 },
    );

    // Kept privately only so another sheet or header row can be read without uploading again.
    const storage = getMediaStorage();
    if (storage) {
      const key = smartStagingKey(projectId, job.id);
      try {
        await storage.put(key, buffer, { maxBytes: SMART_IMPORT_LIMITS.maxBytes });
        await prisma.clientImportJob.update({ where: { id: job.id }, data: { stagingKey: key } });
      } catch (err) {
        console.error("[clients] smart import: could not keep the uploaded file", (err as Error).name);
      }
    }

    await logSystemEvent(
      "INFO",
      "clients",
      `Smart import draft created: ${records.rows.length} rows from ${fileName}`,
      { jobId: job.id, rows: records.rows.length, columns: records.headers.length, sheets: parsed.sheetNames.length, bytes: buffer.length, readMs: Date.now() - started },
      { actorUserId: userId, targetType: "ClientImportJob", targetId: job.id },
    );
    return NextResponse.json({ ok: true, jobId: job.id }, { headers: { "Cache-Control": "no-store" } });
  } finally {
    reading -= 1;
  }
}
