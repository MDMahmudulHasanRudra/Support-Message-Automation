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
}

function parseOne(block: string): ExtractedKnowledge | null {
  const title = block.match(/TITLE:\s*(.+)/i)?.[1]?.trim();
  const categoryRaw = block.match(/CATEGORY:\s*([A-Z_]+)/i)?.[1]?.trim().toUpperCase();
  const questionRaw = block.match(/QUESTION:\s*(.+)/i)?.[1]?.trim();
  const moduleRaw = block.match(/MODULE:\s*(.+)/i)?.[1]?.trim();
  // Answer runs to the end of the block or the next known field, whichever comes first.
  const answer = block.match(/ANSWER:\s*([\s\S]+?)(?:\nCONFIDENCE:|\nMODULE:|$)/i)?.[1]?.trim();
  const confidenceRaw = block.match(/CONFIDENCE:\s*(-?\d+)/i)?.[1];

  if (!title || !answer) return null;

  const category = ALLOWED_KNOWLEDGE_CATEGORIES.find((c) => c === categoryRaw);
  if (!category) return null;

  const question = !questionRaw || questionRaw.toUpperCase() === "NONE" ? null : questionRaw;
  // A record with no parseable confidence is treated as the floor rather than discarded — the
  // caller's own threshold then decides, in one place, whether it is worth keeping.
  const confidence = confidenceRaw ? Math.max(0, Math.min(100, Number(confidenceRaw))) : 0;

  const moduleName = !moduleRaw || moduleRaw.toUpperCase() === "NONE" ? null : moduleRaw.slice(0, 120);

  return { title: title.slice(0, 200), category, question, answer, confidence, module: moduleName };
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
