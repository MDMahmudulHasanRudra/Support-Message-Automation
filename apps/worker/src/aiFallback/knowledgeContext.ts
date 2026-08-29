import { prisma } from "@support-automation/db";
import { derivePatternSignature } from "@support-automation/engine";

/**
 * Finds the knowledge entries worth putting in front of the AI before it answers a customer.
 *
 * Without this the knowledge base was write-only: the builder distilled conversations into it and
 * people reviewed them, but nothing ever read them back, so the AI answered every question from
 * the model's general knowledge alone and none of what the team had learned reached a customer.
 *
 * **Only verified, ACTIVE entries are ever returned.** That restriction is the whole safety story
 * of this file. Entries the knowledge builder writes are unverified by design, and feeding an
 * unverified, model-distilled claim back into a customer-facing answer would launder a
 * hallucination into a citation and then quote it with confidence — each pass making it look
 * better supported than the last. A human confirming an entry is what breaks that loop, so
 * nothing skips it.
 */

/** Enough to ground an answer; more than this crowds the prompt and dilutes every entry in it. */
const MAX_ENTRIES = 3;
/** A long answer is truncated rather than dropped — the opening usually carries the substance. */
const MAX_ANSWER_CHARS = 700;

export interface KnowledgeSnippet {
  id: string;
  title: string;
  question: string | null;
  answer: string;
  /** True when this came from the same group the customer is writing in. */
  fromSameGroup: boolean;
}

interface KnowledgeCandidate {
  id: string;
  title: string;
  question: string | null;
  answer: string;
  sourceGroupId: string | null;
}

/**
 * Ranks candidates against the customer's message. Pure and exported for direct unit testing —
 * no database, no IO.
 *
 * Scoring is deliberately simple keyword overlap rather than embeddings: this app has no vector
 * store, and one extra dependency plus an embedding call per message is a large price for a
 * knowledge base that will hold hundreds of entries, not millions. An entry drawn from the same
 * group wins ties, because the group a question is asked in is a real signal about which answer
 * applies.
 */
export function selectRelevantKnowledge(
  customerMessage: string,
  candidates: KnowledgeCandidate[],
  groupId: string | null,
  limit = MAX_ENTRIES,
): KnowledgeSnippet[] {
  const { keywords } = derivePatternSignature(customerMessage);
  if (keywords.length === 0) return [];

  const scored = candidates
    .map((candidate) => {
      const haystack = `${candidate.title} ${candidate.question ?? ""} ${candidate.answer}`.toLowerCase();
      const overlap = keywords.filter((keyword) => haystack.includes(keyword)).length;
      const fromSameGroup = Boolean(groupId) && candidate.sourceGroupId === groupId;
      return { candidate, overlap, fromSameGroup };
    })
    // An entry sharing no distinctive word with the question is not evidence for it.
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      if (a.fromSameGroup !== b.fromSameGroup) return a.fromSameGroup ? -1 : 1;
      // Stable final tiebreak so the same question always produces the same prompt.
      return a.candidate.id.localeCompare(b.candidate.id);
    });

  return scored.slice(0, limit).map((entry) => ({
    id: entry.candidate.id,
    title: entry.candidate.title,
    question: entry.candidate.question,
    answer:
      entry.candidate.answer.length > MAX_ANSWER_CHARS
        ? `${entry.candidate.answer.slice(0, MAX_ANSWER_CHARS)}…`
        : entry.candidate.answer,
    fromSameGroup: entry.fromSameGroup,
  }));
}

/**
 * Loads the verified knowledge that plausibly relates to this message, then ranks it.
 *
 * The database narrows by keyword so the ranking step never sees the whole table; on a knowledge
 * base of any realistic size this is one cheap query per AI call, which is negligible next to the
 * provider round trip it precedes. Never throws — the caller treats an empty list and a failed
 * lookup identically, because answering without grounding is strictly better than not answering.
 */
export async function findRelevantKnowledge(
  customerMessage: string,
  groupId: string | null,
  limit = MAX_ENTRIES,
): Promise<KnowledgeSnippet[]> {
  const { keywords } = derivePatternSignature(customerMessage);
  if (keywords.length === 0) return [];

  try {
    const candidates = await prisma.aiKnowledgeItem.findMany({
      where: {
        status: "ACTIVE",
        // The safety gate. See this file's header for why it is not negotiable.
        humanVerified: true,
        OR: keywords.flatMap((keyword) => [
          { title: { contains: keyword, mode: "insensitive" as const } },
          { question: { contains: keyword, mode: "insensitive" as const } },
          { answer: { contains: keyword, mode: "insensitive" as const } },
        ]),
      },
      select: { id: true, title: true, question: true, answer: true, sourceGroupId: true },
      // A generous ceiling on what ranking sees — enough that the best entry is in the set,
      // bounded so a huge knowledge base cannot pull an unbounded result into memory.
      take: 40,
    });

    return selectRelevantKnowledge(customerMessage, candidates, groupId, limit);
  } catch (err) {
    console.error("[aiFallback] knowledge lookup failed; answering without it", err);
    return [];
  }
}
