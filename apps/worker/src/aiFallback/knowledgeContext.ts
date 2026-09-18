import { prisma } from "@support-automation/db";
import { containsWholeWord, derivePatternSignature, deriveQueryTerms, normalizeText } from "@support-automation/engine";
import { bandByRelevance, rankByBm25 } from "./bm25.js";

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
  /** The product area this entry belongs to, when the source established one. */
  module: string | null;
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
  /** Optional on the INPUT type so a caller (and a test fixture) need not supply it; the snippet
   *  this produces always carries it, normalised to null. */
  module?: string | null;
  sourceGroupId: string | null;
}

/**
 * Ranks candidates against the customer's message. Pure and exported for direct unit testing —
 * no database, no IO.
 *
 * Scoring is BM25 (see `bm25.ts`) rather than embeddings, and that trade-off is unchanged: this
 * app has no vector store, and one extra dependency plus an embedding call per message is a large
 * price for a knowledge base that will hold hundreds of entries, not millions. What changed is the
 * other side of it — the alternative to embeddings is no longer "count the matching keywords",
 * which gave six possible scores for three hundred candidates and settled the rest with a cuid
 * comparison. BM25 is the strongest ranking obtainable from the text alone and costs one pass.
 *
 * An entry drawn from the same group still wins ties, because the group a question is asked in is
 * a real signal about which answer applies.
 */
export function selectRelevantKnowledge(
  customerMessage: string,
  candidates: KnowledgeCandidate[],
  groupId: string | null,
  limit = MAX_ENTRIES,
  extraKeywords: string[] = [],
): KnowledgeSnippet[] {
  return rankRelevantKnowledge(customerMessage, candidates, groupId, limit, extraKeywords).snippets;
}

/**
 * The ranking pass, plus the score of its best entry.
 *
 * Split out from `selectRelevantKnowledge` (which stays the stable, unit-tested shape callers
 * already use) because `findRelevantKnowledge` now needs to know HOW WELL the direct search did,
 * not merely whether it returned anything — that is what decides if the query expansion is worth
 * running. Re-deriving the score at the call site would mean a second copy of the scoring rule.
 */
export function rankRelevantKnowledge(
  customerMessage: string,
  candidates: KnowledgeCandidate[],
  groupId: string | null,
  limit = MAX_ENTRIES,
  extraKeywords: string[] = [],
): SearchResult {
  // TWO vocabularies, doing two different jobs, and keeping them apart is what confines this
  // change to ordering.
  //
  // `matchVocabulary` is exactly what this function has always used: the pattern signature plus
  // any expansion terms. It still decides WHICH entries are relevant (`overlap > 0`) and still
  // produces `bestOverlap`. Both of those feed decisions outside this function — the relevance
  // filter is recall, and `bestOverlap` is the integer `isStrongEnough` compares against 2 to
  // decide whether to spend a completion on query expansion. Neither may move as a side effect of
  // ranking better, so neither does.
  //
  // `rankVocabulary` adds every content word of the question. It is used ONLY to order the entries
  // already selected above. This is where the old ranker was starved: scoring by how many of at
  // most five signature terms matched gave six possible scores for up to three hundred candidates,
  // so ties were the normal case and a cuid comparison settled them.
  const { keywords: signature } = derivePatternSignature(customerMessage);
  const matchVocabulary = [...new Set([...signature, ...extraKeywords])];
  if (matchVocabulary.length === 0) return { snippets: [], bestOverlap: 0 };
  const rankVocabulary = [...new Set([...matchVocabulary, ...deriveQueryTerms(customerMessage)])];

  const prepared = candidates.map((candidate) => ({
    candidate,
    // Kept as SEPARATE fields rather than concatenated into one haystack, which is the whole point
    // of ranking with BM25F. `procedure` is scored because it is evidence, not decoration — it was
    // rendered into the prompt as `Steps:` and scored against nothing, so the entry whose step list
    // named the exact screen the customer asked about ("Billing → Payment → Pay → Submit") scored
    // zero on "payment" and lost its slot to a vaguer entry that happened to repeat the word in its
    // answer text. Flattening it into one blob fixes that and creates the opposite fault: the step
    // list makes the document longer, and length normalisation then penalises the entry for
    // carrying exactly the content that makes it the right answer.
    fields: {
      title: normalizeText(candidate.title),
      question: normalizeText(candidate.question ?? ""),
      answer: normalizeText(candidate.answer),
      procedure: normalizeText(candidate.procedure ?? ""),
    },
    fromSameGroup: Boolean(groupId) && candidate.sourceGroupId === groupId,
    hasProcedure: Boolean(candidate.procedure?.trim()),
  }));

  // RELEVANCE, unchanged. Whole-word over the match vocabulary, against the fields joined back
  // together — the identical test this function has always applied. `containsWholeWord` is the
  // engine's own primitive and matters here for the reason it always did: a 3-letter token like
  // "net" must not match "internet", "network" and "cabinet", manufacturing grounding out of
  // unrelated entries at the moment the system should have handed over to a person.
  const relevant = prepared
    .map((entry) => {
      const joined = `${entry.fields.title} ${entry.fields.question} ${entry.fields.answer} ${entry.fields.procedure}`;
      const overlap = matchVocabulary.filter((keyword) => containsWholeWord(joined, keyword)).length;
      return { ...entry, overlap };
    })
    // An entry sharing no distinctive word with the question is not evidence for it.
    .filter((entry) => entry.overlap > 0);

  // ORDER, and only order. BM25F over the entries already found relevant: rare terms outweigh
  // common ones, repetition saturates rather than accumulating, a match in the title or the
  // customer-phrased question counts for more than one buried in a paragraph, and each field's
  // length is judged against other instances of that same field.
  const ranked = rankByBm25(
    relevant.map((entry) => ({ id: entry.candidate.id, fields: entry.fields })),
    rankVocabulary,
  );
  const byId = new Map(relevant.map((entry) => [entry.candidate.id, entry]));
  // Equally-relevant bands, so the two signals that were tiebreaks stay tiebreaks. A continuous
  // score makes exact ties vanish, which would have silently retired both of them.
  const bands = bandByRelevance(ranked);

  const scored = ranked
    .map((entry) => ({ ...byId.get(entry.id)!, band: bands.get(entry.id) ?? 0 }))
    .sort((a, b) => {
      if (a.band !== b.band) return a.band - b.band;
      // TIEBREAKS, deliberately not weights — the original reasoning, preserved. Two entries that
      // match the question equally well are not equally useful when the question is "how do I do
      // this": the one carrying real steps is. Because they only ever reorder within a band, they
      // still cannot promote a meaningfully less relevant entry over a more relevant one.
      if (a.hasProcedure !== b.hasProcedure) return a.hasProcedure ? -1 : 1;
      if (a.fromSameGroup !== b.fromSameGroup) return a.fromSameGroup ? -1 : 1;
      // Stable final tiebreak so the same question always produces the same prompt.
      return a.candidate.id.localeCompare(b.candidate.id);
    });

  const snippets = scored.slice(0, limit).map((entry) => ({
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
    module: entry.candidate.module ?? null,
    fromSameGroup: entry.fromSameGroup,
  }));

  // The MAXIMUM matched-term count, not the top-ranked entry's.
  //
  // Those were the same number before and are not any more, which is the one place this change
  // could have leaked out of ranking and into behaviour. Sorting was by overlap descending, so the
  // first entry necessarily held the highest count; BM25 can now put a better-scoring entry with
  // two matched terms above a worse one with three. Reading the count off the new first entry
  // would therefore have moved `isStrongEnough`'s threshold — quietly changing when the system
  // spends a completion on query expansion — as a side effect of reordering. Taking the maximum
  // reproduces the old value exactly, in every case.
  const bestOverlap = scored.reduce((best, entry) => Math.max(best, entry.overlap), 0);
  return { snippets, bestOverlap };
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

  const direct =
    keywords.length > 0
      ? await searchByTerms(customerMessage, keywords, groupId, limit, [])
      : { snippets: [], bestOverlap: 0 };

  // Strong enough to stop here, or nothing to expand with.
  if (isStrongEnough(direct) || !expandTerms) return direct.snippets;

  // Expansion re-searches in a different vocabulary. If there is NOTHING retrievable to re-search,
  // it cannot succeed — no choice of keywords finds a row in an empty set — so the completion it
  // costs is spent to learn something already known.
  //
  // Not a micro-optimisation: on a fresh install, or any deployment whose knowledge base is still
  // unverified, EVERY unmatched customer message paid for an expansion before concluding it had
  // no knowledge. Under STRICT_KNOWLEDGE_ONLY that is the whole of the work done for that message
  // — the reply completion never happens — so the system spent an API call purely to arrive at a
  // conclusion the empty table had already determined.
  //
  // One indexed existence check against `@@index([humanVerified, createdAt])`, and only on the
  // path that was about to spend a completion anyway. It narrows nothing when knowledge exists:
  // the moment there is a single retrievable entry, expansion behaves exactly as before.
  if (!(await hasRetrievableKnowledge())) return direct.snippets;

  // Either the customer's own words found nothing, or they found something thin — a single
  // shared keyword, which on a knowledge base this size is as often a coincidence as a match.
  //
  // The `direct.length > 0` short-circuit this replaces was the more damaging half of the
  // retrieval problem on this deployment. Nearly every verified entry is written in English while
  // most customers write Banglish, so a question like "package upgrade kivabe korbo" reliably
  // matched *something* on its one or two Latin words, and that lone weak hit then suppressed the
  // expansion — the mechanism built specifically to bridge that language gap — at exactly the
  // moment it was needed. Expanding on a weak hit costs one small completion and is paid only
  // when the alternative was answering from thin grounding.
  const expanded = await expandTerms();
  if (expanded.length === 0) return direct.snippets;

  const viaExpansion = await searchByTerms(customerMessage, expanded, groupId, limit, expanded);

  // Keep whichever search actually understood the question better. Ties go to the direct hit:
  // those terms are the customer's own words.
  //
  // The two scores are NOT symmetric, and that is worth knowing before trusting this line too far.
  // `rankRelevantKnowledge` always unions the message's own derived keywords into whatever the
  // caller passes (it has to — scoring a Banglish question purely on English terms would give
  // every row zero), so the expansion side is scored on `derived ∪ expanded` while the direct side
  // is scored on `derived` alone. The larger vocabulary has more chances to match, so expansion is
  // structurally favoured here.
  //
  // Left as it is deliberately. Expansion only runs when the direct search was empty or thin, so
  // being favoured at that point is the behaviour wanted; normalising by vocabulary size would
  // change which entries ground real answers, which is a retrieval-quality decision to make
  // against measurements rather than a correction to slip into a comparison.
  return viaExpansion.bestOverlap > direct.bestOverlap ? viaExpansion.snippets : direct.snippets;
}

/**
 * The bar a direct search must clear before the expansion is skipped.
 *
 * Two distinct matched keywords, or one that led to an entry carrying real steps. A single
 * keyword is the weakest signal this ranker can produce — `derivePatternSignature` yields at most
 * five terms, so one match can be a third of a short question or a single incidental word — and
 * treating it as "found it" is what let a generic article stand in for a procedure nobody had
 * looked for yet.
 */
const MIN_STRONG_OVERLAP = 2;

function isStrongEnough(result: SearchResult): boolean {
  if (result.snippets.length === 0) return false;
  if (result.bestOverlap >= MIN_STRONG_OVERLAP) return true;
  return result.snippets.some((snippet) => Boolean(snippet.procedure?.trim()));
}

interface SearchResult {
  snippets: KnowledgeSnippet[];
  /** Distinct query terms matched by the best-scoring entry — 0 when nothing matched. */
  bestOverlap: number;
}

/**
 * Whether the knowledge base holds anything the customer-facing path is allowed to retrieve.
 *
 * Exactly the gate `searchByTerms` applies — ACTIVE and human-verified — so this answers the only
 * question that matters before paying for an expansion: is there any row a different set of
 * keywords could possibly reach? `findFirst` selecting one id, riding the existing
 * [humanVerified, createdAt] index; it stops at the first hit rather than counting the table.
 *
 * Returns false if the query throws, matching this module's existing posture: a failed lookup and
 * an empty result are treated identically, because answering without grounding is better than not
 * answering, and spending a completion on a database that is not responding is worse than both.
 */
async function hasRetrievableKnowledge(): Promise<boolean> {
  try {
    const any = await prisma.aiKnowledgeItem.findFirst({
      where: { status: "ACTIVE", humanVerified: true },
      select: { id: true },
    });
    return any !== null;
  } catch (err) {
    console.error("[aiFallback] could not check for retrievable knowledge; skipping expansion", err);
    return false;
  }
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
): Promise<SearchResult> {
  // `procedure` is searched alongside the rest: it was selected and rendered to the model but
  // excluded from the narrowing query, so an entry whose answer is one line ("you can do this
  // from the billing screen") and whose steps carry the real vocabulary was unreachable by every
  // word in those steps. This stays a substring `contains` — SQL cannot do a cheap word-boundary
  // match, and it is only the coarse narrowing pass; selectRelevantKnowledge applies the precise
  // whole-word test to whatever it returns.
  const matchesAnyKeyword = searchTerms.flatMap((keyword) => [
    { title: { contains: keyword, mode: "insensitive" as const } },
    { question: { contains: keyword, mode: "insensitive" as const } },
    { answer: { contains: keyword, mode: "insensitive" as const } },
    { procedure: { contains: keyword, mode: "insensitive" as const } },
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
    module: true,
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

    return rankRelevantKnowledge(customerMessage, candidates, groupId, limit, rankingTerms);
  } catch (err) {
    console.error("[aiFallback] knowledge lookup failed; answering without it", err);
    return { snippets: [], bestOverlap: 0 };
  }
}
