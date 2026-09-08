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

/**
 * How many keyword-matching entries the ranking step is allowed to see.
 *
 * Raised from 40 because the importers can now add a few hundred entries in an afternoon, and
 * anything past this ceiling is never ranked at all. Still bounded so a large knowledge base
 * cannot pull an unbounded result into worker memory on every AI reply; a few hundred rows of
 * title/question/answer is a small read next to the provider round trip it precedes.
 */
const MAX_CANDIDATES = 250;
/**
 * A reserved slice for entries learned in the group the customer is writing in. Group provenance
 * is a real signal about which answer applies — it is what breaks ties in the ranking — so it
 * must not be lost to the global cut just because those entries happen to be older.
 */
const MAX_SAME_GROUP_CANDIDATES = 50;

export interface KnowledgeSnippet {
  id: string;
  title: string;
  question: string | null;
  answer: string;
  /**
   * The stored step-by-step for this entry, if somebody wrote one.
   *
   * `AiKnowledgeItem.procedure` has existed and been editable on the knowledge form all along, and
   * nothing ever read it — steps typed into it reached no customer. It is the highest-fidelity
   * material there is for a "how do I do this" question, since it names the actual screens in the
   * actual order, so it goes in front of the answer text rather than instead of it.
   */
  procedure: string | null;
  /** True when this came from the same group the customer is writing in. */
  fromSameGroup: boolean;
}

/**
 * Supplies extra search terms when the customer's own words find nothing. Injected rather than
 * imported so this module keeps its single responsibility and stays testable without an AI client;
 * `runAiFallback.ts` is the one caller that has a resolved client to hand it.
 */
export type QueryExpander = () => Promise<string[]>;

interface KnowledgeCandidate {
  id: string;
  title: string;
  question: string | null;
  answer: string;
  procedure: string | null;
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
  extraKeywords: string[] = [],
): KnowledgeSnippet[] {
  const { keywords: derived } = derivePatternSignature(customerMessage);
  // Ranking has to score on the same vocabulary the candidates were selected with. Scoring a
  // Banglish question against entries found by their English expansion would give every one of
  // them an overlap of zero, and the filter below would discard the rows the query just went to
  // the trouble of finding.
  const keywords = [...new Set([...derived, ...extraKeywords])];
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
    // Truncated on the same budget as the answer. Half a procedure is worse than none — it reads
    // as complete and stops mid-task — but the ellipsis is visible to the model, and the prompt
    // tells it to hand over rather than invent the rest.
    procedure:
      entry.candidate.procedure && entry.candidate.procedure.length > MAX_ANSWER_CHARS
        ? `${entry.candidate.procedure.slice(0, MAX_ANSWER_CHARS)}…`
        : (entry.candidate.procedure ?? null),
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
 *
 * The candidate query is ordered, and that is not cosmetic. Without an `orderBy` Postgres returns
 * an arbitrary page of matching rows in whatever order it reads them, so the entry that would
 * have ranked first could be discarded by `take` before ranking ever ran — and the odds of that
 * grew with every entry an importer added. Newest-first is the meaningful order to cut on: an
 * entry edited or verified more recently is the more likely description of how the product
 * behaves today. `id` breaks the remaining ties so the same question always builds the same
 * prompt, which is what makes an unexpected AI answer reproducible.
 */
export async function findRelevantKnowledge(
  customerMessage: string,
  groupId: string | null,
  limit = MAX_ENTRIES,
  expandTerms?: QueryExpander,
): Promise<KnowledgeSnippet[]> {
  const { keywords } = derivePatternSignature(customerMessage);

  const direct = keywords.length > 0 ? await searchByTerms(customerMessage, keywords, groupId, limit, []) : [];
  if (direct.length > 0 || !expandTerms) return direct;

  // The customer's own words found nothing. Before concluding the knowledge base has no answer,
  // search again in the language the knowledge base is actually written in — see queryExpansion.ts
  // for why that is a different search rather than the same one repeated. Deliberately second: a
  // question that already matched costs no extra round trip, so the expansion is only paid for
  // where the alternative was an ungrounded answer.
  const expanded = await expandTerms();
  if (expanded.length === 0) return direct;

  return searchByTerms(customerMessage, expanded, groupId, limit, expanded);
}

/**
 * One narrowing query plus the ranking pass, run against whichever vocabulary the caller supplies.
 *
 * `searchTerms` selects the candidate rows; `rankingTerms` is what the ranker scores them on, and
 * they differ on the expansion path — the rows are found by their English terms while the message
 * itself is still Banglish. Never throws: the caller treats an empty list and a failed lookup
 * identically, because answering without grounding is strictly better than not answering.
 */
async function searchByTerms(
  customerMessage: string,
  searchTerms: string[],
  groupId: string | null,
  limit: number,
  rankingTerms: string[],
): Promise<KnowledgeSnippet[]> {
  const matchesAnyKeyword = searchTerms.flatMap((keyword) => [
    { title: { contains: keyword, mode: "insensitive" as const } },
    { question: { contains: keyword, mode: "insensitive" as const } },
    { answer: { contains: keyword, mode: "insensitive" as const } },
  ]);
  const where = {
    status: "ACTIVE" as const,
    // The safety gate. See this file's header for why it is not negotiable.
    humanVerified: true,
    OR: matchesAnyKeyword,
  };
  const select = {
    id: true,
    title: true,
    question: true,
    answer: true,
    procedure: true,
    sourceGroupId: true,
  };
  const orderBy = [{ updatedAt: "desc" as const }, { id: "asc" as const }];

  try {
    const [general, sameGroup] = await Promise.all([
      prisma.aiKnowledgeItem.findMany({ where, select, orderBy, take: MAX_CANDIDATES }),
      groupId
        ? prisma.aiKnowledgeItem.findMany({
            where: { ...where, sourceGroupId: groupId },
            select,
            orderBy,
            take: MAX_SAME_GROUP_CANDIDATES,
          })
        : Promise.resolve([]),
    ]);

    const candidates = [...general];
    const seen = new Set(general.map((entry) => entry.id));
    for (const entry of sameGroup) {
      if (!seen.has(entry.id)) candidates.push(entry);
    }

    return selectRelevantKnowledge(customerMessage, candidates, groupId, limit, rankingTerms);
  } catch (err) {
    console.error("[aiFallback] knowledge lookup failed; answering without it", err);
    return [];
  }
}
