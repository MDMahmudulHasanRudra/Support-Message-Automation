import type { AiKnowledgeCategory } from "@prisma/client";

/**
 * Prompt construction and response parsing for the group knowledge builder.
 *
 * `packages/ai-client`'s AiClient has no JSON or tool-use mode (deliberately — see its own doc
 * comment), so this follows the same convention as aiFallback/prompt.ts and
 * learning/aiAnalysisJob.ts: ask for a strict, line-oriented text format and parse it with
 * regexes. A record separator rather than JSON, because a model that trails off mid-answer still
 * yields every complete record before the truncation instead of one unparseable blob.
 */

export interface TranscriptLine {
  at: Date;
  speaker: string;
  isTeamMember: boolean;
  body: string;
}

export interface GroupKnowledgePrompt {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

/** Categories the extractor may choose. Mirrors AiKnowledgeCategory minus the ones no conversation can produce. */
export const ALLOWED_KNOWLEDGE_CATEGORIES: AiKnowledgeCategory[] = [
  "FAQ",
  "TROUBLESHOOTING",
  "WORKFLOW",
  "SOP",
  "SOFTWARE",
  "REQUIREMENT",
  "POLICY",
  "CUSTOMER_RESPONSE",
];

const RECORD_SEPARATOR = "---";

/**
 * The PROCEDURE field, spelled identically for every extractor that emits this record format.
 *
 * Exported and shared rather than restated per prompt for the reason the file header already
 * gives about the record format itself: a field one extractor words differently is a field
 * `parseKnowledgeRecords` silently drops, and the two must never drift. The conservative half of
 * the wording matters as much as the request — the customer-facing prompt tells the model to name
 * real screens and buttons AND forbids inventing them, so a fabricated step here does not produce
 * a slightly-wrong answer, it produces a confident one that sends somebody hunting through
 * software they already find confusing.
 */
export const PROCEDURE_FIELD_SPEC = [
  "PROCEDURE: <the ordered steps, one per line, ONLY if the source actually spells them out —",
  "  otherwise NONE. Name the real screen, menu or button the source names, in the order the",
  "  source gives them. NEVER invent a step, a button name, a menu name, a URL, a permission or",
  "  a prerequisite. If the source describes only part of the task, give only that part. NONE is",
  "  the correct and expected answer for most entries.>",
].join("\n");

/** Long enough to hold a real conversation, short enough to stay inside a modest context window. */
export const MAX_TRANSCRIPT_CHARS = 24_000;

export function buildGroupKnowledgePrompt(input: {
  groupName: string;
  lines: TranscriptLine[];
}): GroupKnowledgePrompt {
  const systemPrompt = [
    "You read real customer support conversations from a WhatsApp group and extract durable,",
    "reusable knowledge from them: the questions this group actually asks, the answers that",
    "resolved them, and the requirements or policies that came up.",
    "Extract only what the conversation genuinely supports. Do not infer, generalise beyond what",
    "was said, or invent product behaviour. If the conversation contains nothing durable — small",
    "talk, scheduling, one-off chatter — return NOTHING.",
    "Never include phone numbers, personal names, order numbers, or any other identifying detail",
    "in what you write. Knowledge is about the product and the process, not about people.",
    "You only ever return text. You cannot send messages or take any action.",
  ].join(" ");

  // Speakers are already reduced to a role by the caller — the model never sees a real name
  // or number, so it cannot copy one into an entry even by accident.
  const transcript = input.lines
    .map((line) => `[${line.isTeamMember ? "SUPPORT" : "CUSTOMER"}] ${line.body}`)
    .join("\n")
    .slice(0, MAX_TRANSCRIPT_CHARS);

  const userPrompt = [
    `Group: ${input.groupName}`,
    "",
    "Conversation:",
    transcript,
    "",
    `Return between 0 and 8 knowledge entries. Separate entries with a line containing only ${RECORD_SEPARATOR}.`,
    "Each entry must use EXACTLY this format, one field per line:",
    "TITLE: <a short descriptive title>",
    `CATEGORY: <one of: ${ALLOWED_KNOWLEDGE_CATEGORIES.join(", ")}>`,
    "QUESTION: <the question a customer would ask, or NONE>",
    "ANSWER: <the answer, written so it can be reused with any customer>",
    PROCEDURE_FIELD_SPEC,
    "CONFIDENCE: <a single integer 0-100 — how well the conversation supports this>",
    "",
    "If there is nothing durable to extract, reply with exactly: NOTHING",
  ].join("\n");

  return { systemPrompt, userPrompt, maxTokens: 2000, temperature: 0 };
}

export interface ExtractedKnowledge {
  title: string;
  category: AiKnowledgeCategory;
  question: string | null;
  answer: string;
  confidence: number;
  /** Which part of the product this is about, when the source made that clear. */
  module: string | null;
  /**
   * Ordered steps, one per line, when the source actually spelled them out — null otherwise.
   *
   * `AiKnowledgeItem.procedure` and the prompt's `Steps:` rendering have both existed all along,
   * but no extractor ever emitted this field, so the only procedures in the knowledge base were
   * the ones a person typed by hand. The customer prompt asks for steps naming the real screens
   * AND forbids inventing them, so with nothing here the model correctly refused and answered
   * generically. This is the field that closes that gap.
   *
   * Null is the honest and expected value for most entries. A fabricated step is worse than no
   * step — it sends somebody hunting through software they already find confusing.
   */
  procedure: string | null;
}

function parseOne(block: string): ExtractedKnowledge | null {
  const title = block.match(/TITLE:\s*(.+)/i)?.[1]?.trim();
  const categoryRaw = block.match(/CATEGORY:\s*([A-Z_]+)/i)?.[1]?.trim().toUpperCase();
  const questionRaw = block.match(/QUESTION:\s*(.+)/i)?.[1]?.trim();
  const moduleRaw = block.match(/MODULE:\s*(.+)/i)?.[1]?.trim();
  // Answer runs to the end of the block or the next known field, whichever comes first.
  // PROCEDURE is in this terminator list because it now sits between ANSWER and CONFIDENCE —
  // without it the answer would swallow the whole step list.
  const answer = block.match(/ANSWER:\s*([\s\S]+?)(?:\nPROCEDURE:|\nCONFIDENCE:|\nMODULE:|$)/i)?.[1]?.trim();
  // Multi-line by design: a procedure is a numbered list, so it runs to the next known field.
  const procedureRaw = block
    .match(/PROCEDURE:\s*([\s\S]+?)(?:\nCONFIDENCE:|\nMODULE:|\nTITLE:|$)/i)?.[1]
    ?.trim();
  const confidenceRaw = block.match(/CONFIDENCE:\s*(-?\d+)/i)?.[1];

  if (!title || !answer) return null;

  const category = ALLOWED_KNOWLEDGE_CATEGORIES.find((c) => c === categoryRaw);
  if (!category) return null;

  const question = !questionRaw || questionRaw.toUpperCase() === "NONE" ? null : questionRaw;
  // A record with no parseable confidence is treated as the floor rather than discarded — the
  // caller's own threshold then decides, in one place, whether it is worth keeping.
  const confidence = confidenceRaw ? Math.max(0, Math.min(100, Number(confidenceRaw))) : 0;

  const moduleName = !moduleRaw || moduleRaw.toUpperCase() === "NONE" ? null : moduleRaw.slice(0, 120);
  // "NONE" is the expected answer for most sources and must round-trip to null rather than being
  // stored as the literal word, which would otherwise be rendered to the model as a step list.
  const procedure =
    !procedureRaw || procedureRaw.toUpperCase() === "NONE" ? null : procedureRaw.slice(0, 2000);

  return {
    title: title.slice(0, 200),
    category,
    question,
    answer,
    confidence,
    module: moduleName,
    procedure,
  };
}

/**
 * Parses the shared knowledge-record format, used by both the group-conversation extractor and
 * the document/pasted-text importer. Exported for direct unit testing — pure text parsing, no IO.
 */
export function parseKnowledgeRecords(text: string): ExtractedKnowledge[] {
  const trimmed = text.trim();
  if (!trimmed || /^NOTHING\b/i.test(trimmed)) return [];

  return trimmed
    .split(new RegExp(`^\\s*${RECORD_SEPARATOR}\\s*$`, "m"))
    .map((block) => parseOne(block))
    .filter((entry): entry is ExtractedKnowledge => entry !== null);
}
