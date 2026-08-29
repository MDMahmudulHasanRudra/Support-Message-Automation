import { prisma } from "@support-automation/db";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { parseKnowledgeRecords, type ExtractedKnowledge } from "./groupKnowledgePrompt.js";
import { buildImportPrompt, chunkDocument } from "./importPrompt.js";

/**
 * Turns one queued KnowledgeImport — pasted documentation or an uploaded file — into structured
 * knowledge entries.
 *
 * Runs in the worker rather than in a server action because a manual can be far larger than one
 * model call: it is chunked, each chunk is a separate API round trip, and the whole thing has to
 * survive a restart and report progress while it runs. The dashboard writes the row and watches
 * its status, which is the same DB-mediated hand-off every other worker action uses.
 *
 * Everything produced lands **unverified**, exactly like the conversation builder's output. That
 * is the trust boundary: documentation is authoritative, but a model's reading of it is still a
 * reading, and only a person confirming an entry lets it reach a customer.
 */

/** Below this the model is extrapolating from the text rather than reporting it. */
const MIN_CONFIDENCE_TO_STORE = 55;
/** A per-chunk ceiling; a section producing more than this is being padded, not summarised. */
const MAX_ENTRIES_PER_CHUNK = 10;
/**
 * A hard ceiling per import. Protects the review queue: nobody can meaningfully check three
 * hundred entries in one sitting, and an import that would produce that many should be split
 * into per-module imports the reviewer can actually work through.
 */
const MAX_ENTRIES_PER_IMPORT = 120;

export interface KnowledgeImportRunResult {
  ran: boolean;
  importId?: string;
  entriesCreated?: number;
  skipped?: string;
}

/** Atomically claims one PENDING import, or null if none are waiting. */
async function claimNextImport() {
  const candidate = await prisma.knowledgeImport.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const claim = await prisma.knowledgeImport.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", startedAt: new Date() },
  });
  // Lost the race. Single worker today, but the guard costs nothing and this is the exact
  // pattern the outbound queue uses.
  if (claim.count === 0) return null;

  return prisma.knowledgeImport.findUniqueOrThrow({ where: { id: candidate.id } });
}

/** `clientOverride` is a test-only seam, mirroring the other AI jobs — production never passes it. */
export async function processOneKnowledgeImport(clientOverride?: AiClient): Promise<KnowledgeImportRunResult> {
  const aiSettings = await prisma.aiSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
  // Only the master switch. Unlike the conversation builder this is not gated on
  // knowledgeFromChatEnabled: importing your own documentation is an explicit, human-initiated
  // act, not the automatic observation of customer chats that flag governs.
  if (!aiSettings.aiEngineEnabled) return { ran: false, skipped: "AI_ENGINE_DISABLED" };

  const job = await claimNextImport();
  if (!job) return { ran: false, skipped: "NOTHING_QUEUED" };

  const client = clientOverride ?? (await resolveAiClient("LEARNING"));
  if (!client) {
    await failImport(job.id, "No AI provider is configured for the LEARNING job. Assign one on AI Models, then retry.");
    return { ran: false, importId: job.id, skipped: "NO_AI_CLIENT" };
  }

  const chunks = chunkDocument(job.rawText);
  if (chunks.length === 0) {
    await failImport(job.id, "There was no readable text in this import.");
    return { ran: false, importId: job.id, skipped: "EMPTY" };
  }

  await prisma.knowledgeImport.update({ where: { id: job.id }, data: { chunksTotal: chunks.length } });

  let created = 0;
  let failedChunks = 0;
  let lastError: string | null = null;

  for (const [index, chunk] of chunks.entries()) {
    if (created >= MAX_ENTRIES_PER_IMPORT) break;

    let extracted: ExtractedKnowledge[] = [];
    try {
      const completion = await client.complete(
        buildImportPrompt({
          label: job.label,
          module: job.module,
          chunk,
          chunkIndex: index,
          chunkCount: chunks.length,
        }),
      );
      extracted = parseKnowledgeRecords(completion.text).slice(0, MAX_ENTRIES_PER_CHUNK);
    } catch (err) {
      // One bad chunk must not throw away the entries every other chunk produced — a 40-page
      // manual failing at page 30 should still leave you 29 pages of knowledge.
      failedChunks += 1;
      lastError = (err as Error).message;
    }

    const worthStoring = extracted
      .filter((entry) => entry.confidence >= MIN_CONFIDENCE_TO_STORE)
      .slice(0, MAX_ENTRIES_PER_IMPORT - created);

    created += await storeImportedKnowledge(job.id, job.label, job.module, worthStoring);

    await prisma.knowledgeImport.update({
      where: { id: job.id },
      data: { chunksDone: index + 1, entriesCreated: created },
    });
  }

  const status = failedChunks === 0 ? "COMPLETED" : created > 0 ? "PARTIAL" : "FAILED";
  await prisma.knowledgeImport.update({
    where: { id: job.id },
    data: {
      status,
      completedAt: new Date(),
      entriesCreated: created,
      error:
        failedChunks === 0
          ? null
          : `${failedChunks} of ${chunks.length} sections could not be processed. Last error: ${lastError ?? "unknown"}`,
    },
  });

  await logSystemEvent(failedChunks === 0 ? "INFO" : "WARN", "knowledge-import", `Import "${job.label}" ${status.toLowerCase()}`, {
    importId: job.id,
    chunks: chunks.length,
    failedChunks,
    entriesCreated: created,
  });

  return { ran: true, importId: job.id, entriesCreated: created };
}

async function failImport(importId: string, error: string): Promise<void> {
  await prisma.knowledgeImport.update({
    where: { id: importId },
    data: { status: "FAILED", error, completedAt: new Date() },
  });
}

/**
 * Stores what cleared the confidence floor, skipping titles this same import already produced.
 *
 * Dedup is scoped to the import rather than the whole knowledge base on purpose: two different
 * manuals describing the same feature from different angles are both worth having, and a
 * cross-source title collision is a judgement call for the reviewer, not for this function.
 */
async function storeImportedKnowledge(
  importId: string,
  label: string,
  moduleHint: string | null,
  entries: ExtractedKnowledge[],
): Promise<number> {
  if (entries.length === 0) return 0;

  const existing = await prisma.aiKnowledgeItem.findMany({
    where: { importId, title: { in: entries.map((e) => e.title) } },
    select: { title: true },
  });
  const seen = new Set(existing.map((item) => item.title));

  // Also de-duplicate within this batch, since one chunk can repeat a heading.
  const fresh = entries.filter((entry) => {
    if (seen.has(entry.title)) return false;
    seen.add(entry.title);
    return true;
  });
  if (fresh.length === 0) return 0;

  await prisma.aiKnowledgeItem.createMany({
    data: fresh.map((entry) => ({
      title: entry.title,
      category: entry.category,
      question: entry.question,
      answer: entry.answer,
      // The operator's module hint wins over the model's guess: they know their product.
      module: moduleHint ?? entry.module,
      source: "IMPORT",
      importId,
      sourceLabel: label,
      confidence: entry.confidence,
      aiGenerated: true,
      humanVerified: false,
    })),
  });

  return fresh.length;
}
