import type { AiClient } from "@support-automation/ai-client";
import { formatConversationTranscript, type ConversationTurn } from "./conversationContext.js";

/**
 * Turns a customer's question into English search terms, so verified knowledge written in English
 * can still be found when the question was not asked in it.
 *
 * `findRelevantKnowledge()` matches by substring: a term only finds an entry when it literally
 * appears in that entry's title, question or answer. That works for a customer who writes
 * "billing" and stops working entirely for one who writes the same question in Bengali script,
 * where there is no character in common with an English entry to match on. It is also thinner than
 * it looks for Banglish: "Bkash Payment delete korbo kivabe" only matches on the English nouns that
 * survived, while the words carrying the intent — korbo, kivabe — match nothing. On this
 * deployment that is not an edge case: of the verified knowledge, 316 of 318 entries are English
 * only, while the customers writing in produce a majority of Banglish and a real minority of
 * Bengali script.
 *
 * The consequence was not an unanswered question, which would at least be visible. Retrieval
 * returned nothing, the response mode permitted a general answer, and the model wrote a fluent,
 * plausible, entirely generic one — bKash payments deleted from "payment history" on a product
 * that has four verified entries about bKash. A confident wrong answer is worse than a handover,
 * and it is invisible in the logs because the reply looks like a success.
 *
 * **This widens the search only.** It cannot introduce content: the terms are used to select
 * candidate rows, and the `humanVerified` + `ACTIVE` gate in `knowledgeContext.ts` is untouched.
 * The worst an expansion can do is retrieve nothing, which is exactly where it was called from.
 */

/** Enough synonyms to cover a question's phrasings; past this the search stops discriminating. */
const MAX_TERMS = 8;
/** One-character tokens match almost everything under a substring search. */
const MIN_TERM_LENGTH = 2;
/** A "term" longer than this is the model writing prose instead of keywords. */
const MAX_TERM_CHARS = 32;
/** The question, not the conversation — a long paste costs tokens without sharpening the search. */
const MAX_MESSAGE_CHARS = 400;

const SYSTEM_PROMPT = [
  "You turn a customer support question into English search keywords for a documentation search.",
  "",
  "The customer may write in English, Bengali, or Banglish (Bengali written in Latin letters).",
  "The documentation is written in English. Your job is to bridge that gap.",
  "",
  "Rules:",
  "- Output ONLY lowercase English keywords separated by commas. No sentences, no explanation.",
  "- Translate the intent, do not transliterate: 'bill kivabe generate korbo' becomes",
  "  'bill, invoice, generate, create, billing'.",
  "- Include the obvious synonyms a manual might use instead of the customer's word",
  "  ('delete' also as 'remove', 'cancel').",
  "- Keep product and brand names as they are written ('bkash', 'mikrotik', 'ispdigital').",
  `- At most ${MAX_TERMS} keywords. Prefer nouns and verbs that would appear in a manual.`,
  "- If the message carries no searchable subject at all (a greeting, 'ok', 'thanks'), output",
  "  nothing at all.",
  "",
  "You may be given the conversation so far. A follow-up question often carries no subject of its",
  "own — 'does the same apply for this client?' is unsearchable until you read what 'the same'",
  "was. Take the subject from the earlier turns and write keywords for THAT, not for the",
  "pronouns. If the conversation does not settle what is being asked either, output nothing:",
  "searching for the wrong subject is worse than searching for none.",
].join("\n");

/**
 * Parses the model's reply into usable search terms. Pure and exported for direct unit testing —
 * the model is asked for a comma-separated list and mostly obliges, so this has to be tolerant of
 * the ways it does not: a numbered list, newlines, a stray "Keywords:" preamble, quotes, or a
 * sentence that slipped through.
 */
export function parseExpandedTerms(raw: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const piece of raw.split(/[,\n;]+/)) {
    // Strip list bullets/numbering and any punctuation, keeping letters, digits and inner spaces.
    const cleaned = piece
      .replace(/^\s*[-*\d.)\]]+\s*/, "")
      .replace(/^\s*keywords?\s*:/i, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();

    if (cleaned.length < MIN_TERM_LENGTH || cleaned.length > MAX_TERM_CHARS) continue;
    // A multi-word phrase is prose, not a keyword — and a substring search would rarely match it.
    if (cleaned.split(" ").length > 2) continue;
    if (seen.has(cleaned)) continue;

    seen.add(cleaned);
    terms.push(cleaned);
    if (terms.length >= MAX_TERMS) break;
  }

  return terms;
}

/**
 * Asks the model for English search terms for this question.
 *
 * **Never throws.** The caller is mid-conversation with a customer, and this runs only where
 * retrieval already came back empty — so every failure mode has to degrade to "no expansion",
 * leaving exactly the behaviour that existed before this function did.
 */
export async function expandQueryTerms(
  client: AiClient,
  customerMessage: string,
  conversation: ConversationTurn[] = [],
): Promise<string[]> {
  const question = customerMessage.trim().slice(0, MAX_MESSAGE_CHARS);
  if (question.length < MIN_TERM_LENGTH) return [];

  const transcript = formatConversationTranscript(conversation);
  const userPrompt = transcript
    ? `Conversation so far:\n${transcript}\n\nLatest message to search for:\n${question}`
    : question;

  try {
    const completion = await client.complete({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      // Keywords, not prose. Small enough that a model ignoring the format runs out before it can
      // write a paragraph the parser would have to reject anyway.
      maxTokens: 120,
      // Deterministic: the same question should search for the same thing every time, or an
      // unexpected answer cannot be reproduced from the message that caused it.
      temperature: 0,
    });
    return parseExpandedTerms(completion.text ?? "");
  } catch (err) {
    console.error("[aiFallback] query expansion failed; searching with the original words only", err);
    return [];
  }
}
