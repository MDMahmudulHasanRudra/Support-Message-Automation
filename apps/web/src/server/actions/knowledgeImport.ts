"use server";

import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import { prisma } from "@support-automation/db";
import type { KnowledgeImportSourceType, Prisma } from "@prisma/client";
import { parseKnowledgeImportRows, validateImportUrl } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";
import {
  extractDocxText,
  extractPdfText,
  fetchImportablePage,
  MAX_KNOWLEDGE_UPLOAD_BYTES,
  uploadTooLargeMessage,
} from "@/lib/knowledgeSources";

/** One row of the report a spreadsheet import shows straight back on the form. */
export interface SpreadsheetImportRow {
  rowNumber: number;
  title: string;
  outcome: "CREATED" | "SKIPPED";
  reason: string;
}

export interface SpreadsheetImportReport {
  created: number;
  skipped: number;
  rows: SpreadsheetImportRow[];
}

export interface KnowledgeImportState {
  error?: string;
  /** File-level problems with an uploaded spreadsheet — nothing was read, so there are no rows. */
  fileErrors?: string[];
  queuedId?: string;
  /** Present only for a spreadsheet, which creates its entries immediately rather than queueing. */
  spreadsheet?: SpreadsheetImportReport;
}

/** Beyond this the review queue becomes unworkable — split the document per module instead. */
const MAX_TEXT_CHARS = 400_000;
const MIN_TEXT_CHARS = 40;

/**
 * How an upload is read, decided by extension. Each kind has a genuinely different path: text and
 * documents are queued for the AI to structure, a spreadsheet already *is* structured and never
 * goes near a model.
 */
const UPLOAD_KINDS = {
  TEXT: [".txt", ".md", ".markdown"],
  PDF: [".pdf"],
  DOCX: [".docx"],
  SPREADSHEET: [".csv", ".xlsx"],
} as const;

type UploadKind = keyof typeof UPLOAD_KINDS;

function classifyUpload(fileName: string): UploadKind | null {
  const lower = fileName.toLowerCase();
  for (const [kind, extensions] of Object.entries(UPLOAD_KINDS) as Array<[UploadKind, readonly string[]]>) {
    if (extensions.some((ext) => lower.endsWith(ext))) return kind;
  }
  return null;
}

const UNSUPPORTED_UPLOAD_HINT = Object.values(UPLOAD_KINDS).flat().join(", ");

/**
 * Queues a block of product documentation for structuring into knowledge entries, or — for a
 * question/answer spreadsheet — creates the entries outright.
 *
 * The queued paths write one KnowledgeImport row and stop: the worker does the chunking and the AI
 * calls, which is the same DB-mediated hand-off every other worker action uses and matters here
 * because a real manual is many API calls, far longer than a form submit should block for.
 *
 * A spreadsheet is the deliberate exception. Its rows are already the answers, so passing them
 * through a model would spend calls to restate a Question column and an Answer column, and put a
 * possible hallucination between what the operator wrote and what gets stored. It is parsed here
 * and reported row by row, exactly like the automation-rules import.
 */
export async function queueKnowledgeImport(
  _prevState: KnowledgeImportState,
  formData: FormData,
): Promise<KnowledgeImportState> {
  const session = await requireSession();

  const moduleName = String(formData.get("module") ?? "").trim() || null;
  const mode = String(formData.get("mode") ?? "paste");
  let label = String(formData.get("label") ?? "").trim();
  let rawText = String(formData.get("text") ?? "").trim();
  let sourceType: KnowledgeImportSourceType = "PASTED_TEXT";
  let sourceUrl: string | null = null;
  let fileName: string | null = null;

  if (mode === "url") {
    const rawUrl = String(formData.get("url") ?? "");
    const checked = validateImportUrl(rawUrl);
    if (!checked.ok) return { error: checked.error };

    const fetched = await fetchImportablePage(checked.url);
    if ("error" in fetched) return { error: fetched.error };

    rawText = fetched.text;
    sourceUrl = fetched.finalUrl;
    sourceType = "URL";
    if (!label) {
      const parsed = new URL(fetched.finalUrl);
      label = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    }
  } else if (mode === "file") {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { error: "Choose a file to upload, or switch to Write or paste text." };
    }

    const kind = classifyUpload(file.name);
    if (!kind) {
      return {
        error: `${file.name} is not a format this import can read. Supported: ${UNSUPPORTED_UPLOAD_HINT}. For anything else, copy the text out and paste it.`,
      };
    }
    // Checked against a limit below Next's own 8MB Server Action body cap, so the operator gets
    // this message instead of the framework's generic request failure.
    if (file.size > MAX_KNOWLEDGE_UPLOAD_BYTES) {
      return { error: uploadTooLargeMessage(file.name, file.size) };
    }

    fileName = file.name;
    if (!label) label = file.name;

    if (kind === "SPREADSHEET") {
      return importKnowledgeSpreadsheet({
        file,
        label,
        moduleName,
        userId: session.userId,
      });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (kind === "PDF") {
      const extracted = await extractPdfText(bytes, file.name);
      // A scanned or encrypted PDF is refused here rather than queued: the import would make its
      // API calls, produce nothing, and report a failure the operator could not act on.
      if ("error" in extracted) return { error: extracted.error };
      rawText = extracted.text;
      sourceType = "PDF";
    } else if (kind === "DOCX") {
      const extracted = await extractDocxText(bytes, file.name);
      if ("error" in extracted) return { error: extracted.error };
      rawText = extracted.text;
      sourceType = "DOCX";
    } else {
      rawText = new TextDecoder("utf-8").decode(bytes).trim();
      sourceType = "DOCUMENT";
    }
  }

  if (!label) return { error: "Give this a name so you can recognise it in the review queue." };
  if (rawText.length < MIN_TEXT_CHARS) {
    return { error: "There is not enough text here to extract anything useful from." };
  }
  if (rawText.length > MAX_TEXT_CHARS) {
    return { error: tooMuchTextMessage(rawText.length) };
  }

  const created = await prisma.knowledgeImport.create({
    data: { label, sourceType, rawText, sourceUrl, fileName, module: moduleName, createdById: session.userId },
    select: { id: true },
  });

  await logSystemEvent("INFO", "knowledge-import", `Knowledge import "${label}" queued`, {
    importId: created.id,
    sourceType,
    sourceUrl,
    characters: rawText.length,
    module: moduleName,
    userId: session.userId,
  });

  revalidatePath("/ai-learning/knowledge-base/import");
  return { queuedId: created.id };
}

function tooMuchTextMessage(length: number): string {
  return `That is ${length.toLocaleString("en-US")} characters. Import at most ${MAX_TEXT_CHARS.toLocaleString("en-US")} at a time — a document this large produces more entries than anyone can review in one sitting. Split it by module.`;
}

/**
 * Reads a question/answer sheet and creates the entries directly, with no AI call anywhere in the
 * path. Partial success by design, matching this repo's other Excel imports: valid rows are
 * created and bad rows are skipped with a recorded reason, rather than one typo discarding a file
 * somebody spent an afternoon on.
 *
 * A KnowledgeImport row is still written, so the history table shows where these entries came
 * from — but it lands COMPLETED (or FAILED), never PENDING, because the worker must not pick a
 * spreadsheet up and feed its raw CSV to a model.
 */
async function importKnowledgeSpreadsheet({
  file,
  label,
  moduleName,
  userId,
}: {
  file: File;
  label: string;
  moduleName: string | null;
  userId: string;
}): Promise<KnowledgeImportState> {
  let rawRows: Array<Record<string, unknown>>;
  let csvText: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { fileErrors: ["That file has no sheets in it."] };
    const sheet = workbook.Sheets[sheetName]!;
    rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    // Retained as the import's rawText for provenance — the entries themselves hold the content,
    // so this is only ever read by a person asking "what exactly did we upload?".
    csvText = XLSX.utils.sheet_to_csv(sheet);
  } catch {
    return {
      fileErrors: [
        `${file.name} could not be read as a spreadsheet. Save it as .xlsx or .csv and try again — the Download Template button gives you the expected columns.`,
      ],
    };
  }

  const { results, fileErrors } = parseKnowledgeImportRows(rawRows);
  if (fileErrors.length > 0) return { fileErrors };
  if (csvText.length > MAX_TEXT_CHARS) return { fileErrors: [tooMuchTextMessage(csvText.length)] };

  const valid = results.filter((result) => result.outcome === "VALID" && result.row);
  const titles = valid.map((result) => result.row!.title);
  const existing =
    titles.length > 0
      ? await prisma.aiKnowledgeItem.findMany({
          where: { title: { in: titles }, status: { not: "ARCHIVED" } },
          select: { title: true },
        })
      : [];
  const existingTitles = new Set(existing.map((item) => item.title.trim().toLowerCase()));

  const rows: SpreadsheetImportRow[] = [];
  const toCreate: Prisma.AiKnowledgeItemCreateManyInput[] = [];

  const importRecord = await prisma.knowledgeImport.create({
    data: {
      label,
      sourceType: "SPREADSHEET",
      rawText: csvText,
      fileName: file.name,
      module: moduleName,
      createdById: userId,
      // Nothing is queued for the worker: the rows are created below, in this request.
      status: valid.length > 0 ? "COMPLETED" : "FAILED",
      chunksTotal: 0,
      chunksDone: 0,
      completedAt: new Date(),
      error: valid.length > 0 ? null : "No valid rows were found in this file.",
    },
    select: { id: true },
  });

  for (const result of results) {
    if (result.outcome !== "VALID" || !result.row) {
      rows.push({ rowNumber: result.rowNumber, title: result.row?.title ?? "", outcome: "SKIPPED", reason: result.reason });
      continue;
    }

    const collides = existingTitles.has(result.row.title.trim().toLowerCase());
    toCreate.push({
      title: result.row.title,
      category: result.row.category,
      question: result.row.question,
      answer: result.row.answer,
      procedure: result.row.procedure,
      // The operator's module hint applies to the whole file and wins over a per-row value.
      module: moduleName ?? result.row.module,
      source: "IMPORT",
      importId: importRecord.id,
      sourceLabel: label,
      // No model read this file, so there is no confidence to record and nothing was generated.
      aiGenerated: false,
      // Explicit, because the column defaults to true. Bulk-created entries have to land in the
      // review queue like everything else — only a person typing one entry by hand is verified on
      // creation, and retrieval only ever serves verified entries.
      humanVerified: false,
      createdById: userId,
    });
    rows.push({
      rowNumber: result.rowNumber,
      title: result.row.title,
      outcome: "CREATED",
      reason: collides
        ? "Created — but an entry with this title already exists, so check for overlap when reviewing."
        : "Created, waiting for review.",
    });
  }

  if (toCreate.length > 0) {
    try {
      await prisma.aiKnowledgeItem.createMany({ data: toCreate });
    } catch (err) {
      await logSystemEvent("ERROR", "knowledge-import", "Spreadsheet knowledge import insert failed", {
        importId: importRecord.id,
        attempted: toCreate.length,
        error: (err as Error).message,
      });
      await prisma.knowledgeImport.update({
        where: { id: importRecord.id },
        data: { status: "FAILED", error: "The entries could not be saved. See System Logs for details." },
      });
      return {
        error: "The rows read correctly but could not be saved. Nothing was created — see System Logs, then try again.",
      };
    }
  }

  const created = toCreate.length;
  const skipped = rows.length - created;
  await prisma.knowledgeImport.update({
    where: { id: importRecord.id },
    data: { entriesCreated: created },
  });

  await logSystemEvent("INFO", "knowledge-import", `Spreadsheet import "${label}": ${created} entries created`, {
    importId: importRecord.id,
    created,
    skipped,
    module: moduleName,
    userId,
  });

  revalidatePath("/ai-learning/knowledge-base/import");
  revalidatePath("/ai-learning/knowledge-base/review");
  revalidatePath("/ai-learning/knowledge-base");
  return { spreadsheet: { created, skipped, rows } };
}

/** Re-queues a failed or disappointing import against the text it already holds. */
export async function retryKnowledgeImport(id: string): Promise<void> {
  await requireSession();
  await prisma.knowledgeImport.updateMany({
    // Only a finished import can be retried; one mid-flight would be claimed twice. A SPREADSHEET
    // import is excluded outright: its rawText is CSV that was never meant for a model, and its
    // real fix is correcting the file and uploading it again.
    where: { id, status: { in: ["FAILED", "PARTIAL", "COMPLETED"] }, sourceType: { not: "SPREADSHEET" } },
    data: { status: "PENDING", error: null, chunksDone: 0, startedAt: null, completedAt: null },
  });
  revalidatePath("/ai-learning/knowledge-base/import");
}
