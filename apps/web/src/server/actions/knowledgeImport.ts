"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface KnowledgeImportState {
  error?: string;
  queuedId?: string;
}

/** Beyond this the review queue becomes unworkable — split the document per module instead. */
const MAX_TEXT_CHARS = 400_000;
const MIN_TEXT_CHARS = 40;

/** Plain-text formats only, for now. A PDF or DOCX needs a parsing dependency this app doesn't carry yet. */
const ACCEPTED_EXTENSIONS = [".txt", ".md", ".markdown", ".csv"];

/**
 * Queues a block of product documentation for structuring into knowledge entries.
 *
 * Writes one KnowledgeImport row and stops — the worker does the chunking and the AI calls. That
 * is the same DB-mediated hand-off every other worker action uses, and it matters here for a
 * practical reason too: a real manual is many API calls, which is far longer than a form submit
 * should ever block for.
 */
export async function queueKnowledgeImport(
  _prevState: KnowledgeImportState,
  formData: FormData,
): Promise<KnowledgeImportState> {
  const session = await requireSession();

  const moduleName = String(formData.get("module") ?? "").trim() || null;
  const pasted = String(formData.get("text") ?? "").trim();
  const file = formData.get("file");
  let label = String(formData.get("label") ?? "").trim();
  let rawText = pasted;
  let sourceType: "PASTED_TEXT" | "DOCUMENT" = "PASTED_TEXT";

  if (file instanceof File && file.size > 0) {
    const lowerName = file.name.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
      return {
        error: `${file.name} is not a plain-text file. Upload .txt or .md, or paste the text directly — PDF and Word support is not built yet.`,
      };
    }
    rawText = (await file.text()).trim();
    sourceType = "DOCUMENT";
    if (!label) label = file.name;
  }

  if (!label) return { error: "Give this a name so you can recognise it in the review queue." };
  if (rawText.length < MIN_TEXT_CHARS) {
    return { error: "There is not enough text here to extract anything useful from." };
  }
  if (rawText.length > MAX_TEXT_CHARS) {
    return {
      error: `That is ${rawText.length.toLocaleString("en-US")} characters. Import at most ${MAX_TEXT_CHARS.toLocaleString("en-US")} at a time — a document this large produces more entries than anyone can review in one sitting. Split it by module.`,
    };
  }

  const created = await prisma.knowledgeImport.create({
    data: { label, sourceType, rawText, module: moduleName, createdById: session.userId },
    select: { id: true },
  });

  await logSystemEvent("INFO", "knowledge-import", `Knowledge import "${label}" queued`, {
    importId: created.id,
    characters: rawText.length,
    module: moduleName,
    userId: session.userId,
  });

  revalidatePath("/ai-learning/knowledge-base/import");
  return { queuedId: created.id };
}

/** Re-queues a failed or disappointing import against the text it already holds. */
export async function retryKnowledgeImport(id: string): Promise<void> {
  await requireSession();
  await prisma.knowledgeImport.updateMany({
    // Only a finished import can be retried; one mid-flight would be claimed twice.
    where: { id, status: { in: ["FAILED", "PARTIAL", "COMPLETED"] } },
    data: { status: "PENDING", error: null, chunksDone: 0, startedAt: null, completedAt: null },
  });
  revalidatePath("/ai-learning/knowledge-base/import");
}
