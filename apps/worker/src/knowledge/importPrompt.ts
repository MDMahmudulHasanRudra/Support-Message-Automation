import { ALLOWED_KNOWLEDGE_CATEGORIES } from "./groupKnowledgePrompt.js";

/**
 * Prompt for turning product documentation — a pasted manual section, an uploaded guide, a
 * policy — into structured knowledge entries.
 *
 * Separate from the group-conversation prompt because the material is genuinely different.
 * A chat log has to be *interpreted*: what did the customer mean, what actually resolved it.
 * Documentation is already authoritative and has to be *preserved*: the job is to break it into
 * retrievable, self-contained pieces without rewriting what it says. The two share the record
 * format and its parser (`parseKnowledgeRecords`), and nothing else.
 */

/**
 * Chunk size, in characters. Sized so a chunk plus the instructions sits comfortably inside a
 * modest context window, while still being long enough to hold a whole topic — splitting a
 * procedure across two chunks produces two half-answers, which is worse than a slightly large
 * request.
 */
export const CHUNK_TARGET_CHARS = 6000;
/** A chunk this small is a stray heading or footer, not a topic worth an API call. */
const MIN_CHUNK_CHARS = 200;

/**
 * Splits a document on its own structure — blank lines, then headings — rather than at a fixed
 * offset, so a chunk boundary lands between topics instead of mid-sentence.
 *
 * Exported for direct unit testing: pure string work, no IO.
 */
export function chunkDocument(rawText: string, targetChars = CHUNK_TARGET_CHARS): string[] {
  const normalized = rawText.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).flatMap((paragraph) => {
    // A single paragraph longer than the target (a wall of text with no blank lines) is split
    // on sentence ends so a chunk still breaks at a natural boundary.
    if (paragraph.length <= targetChars) return [paragraph];
    return paragraph.match(new RegExp(`[\\s\\S]{1,${targetChars}}(?:[.!?]\\s|$)`, "g")) ?? [paragraph];
  });

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > targetChars && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  // Anything below the floor is folded into its neighbour rather than spending a call on it.
  return chunks.reduce<string[]>((acc, chunk) => {
    if (chunk.length < MIN_CHUNK_CHARS && acc.length > 0) {
      acc[acc.length - 1] = `${acc[acc.length - 1]}\n\n${chunk}`;
      return acc;
    }
    acc.push(chunk);
    return acc;
  }, []);
}

export interface ImportPrompt {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

export function buildImportPrompt(input: {
  /** What this text came from — a file name or a title the operator typed. */
  label: string;
  /** Optional module hint applied to the whole import, e.g. "MikroTik Integration". */
  module: string | null;
  chunk: string;
  chunkIndex: number;
  chunkCount: number;
}): ImportPrompt {
  const systemPrompt = [
    "You convert a company's own product documentation into a structured knowledge base that a",
    "support assistant will later answer customers from.",
    "Preserve what the document says. Do not rewrite it into something more general, do not add",
    "detail it does not contain, and do not correct it against your own knowledge of similar",
    "products — this describes THIS company's software, and where it differs from the norm, the",
    "difference is the whole point.",
    "Each entry must stand on its own: someone reading it without the surrounding document must",
    "be able to act on it. Prefer several specific entries over one broad one.",
    "Skip tables of contents, page headers and footers, revision histories, and anything else",
    "that carries no answer.",
    "You only ever return text. You cannot send messages or take any action.",
  ].join(" ");

  const userPrompt = [
    `Source: ${input.label}`,
    input.module ? `Module: ${input.module}` : null,
    input.chunkCount > 1 ? `Section ${input.chunkIndex + 1} of ${input.chunkCount}.` : null,
    "",
    "Documentation:",
    input.chunk,
    "",
    "Return between 0 and 10 knowledge entries. Separate entries with a line containing only ---.",
    "Each entry must use EXACTLY this format, one field per line:",
    "TITLE: <a short descriptive title>",
    `CATEGORY: <one of: ${ALLOWED_KNOWLEDGE_CATEGORIES.join(", ")}>`,
    input.module
      ? `MODULE: ${input.module}`
      : "MODULE: <the product area this belongs to, or NONE>",
    "QUESTION: <the question a customer or colleague would ask to reach this, or NONE>",
    "ANSWER: <the answer, complete enough to act on without the rest of the document>",
    "CONFIDENCE: <a single integer 0-100 — how directly the text supports this entry>",
    "",
    "If this section contains nothing worth keeping, reply with exactly: NOTHING",
  ]
    .filter((line) => line !== null)
    .join("\n");

  // Larger than the conversation extractor's budget: documentation chunks legitimately yield
  // more entries, and a truncated response loses whatever did not fit.
  return { systemPrompt, userPrompt, maxTokens: 3000, temperature: 0 };
}
