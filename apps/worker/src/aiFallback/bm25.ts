import { countWholeWord, tokenizeWords } from "@support-automation/engine";

/**
 * BM25F ranking for knowledge retrieval.
 *
 * What it replaces, and why that mattered: the previous score was the COUNT of query keywords
 * present in an entry. `derivePatternSignature` yields at most five keywords, so every candidate —
 * up to three hundred of them — was sorted into at most five buckets. Ties were not an edge case,
 * they were the normal case, and they were broken by `hasProcedure`, then `fromSameGroup`, then
 * `id.localeCompare`. That last one is a cuid. Which three of possibly dozens of equally-scoring
 * verified entries were put in front of a customer came down to alphabetical order over a random
 * identifier.
 *
 * Counting also gets three things wrong that BM25 exists to fix:
 *
 * - **Every term was worth the same.** Matching "bill", which appears in nearly every billing
 *   entry, counted exactly as much as matching "prorated", which appears in one. The rare term is
 *   the one that tells you which entry to use, and it was being drowned out by the common one.
 *   `IDF` is the correction: a term shared by everything carries almost no weight, a term unique to
 *   one entry carries a lot.
 * - **Repetition accumulated without limit.** An entry mentioning "invoice" ten times is more about
 *   invoices than one mentioning it once, but not ten times more. `k1` saturates that curve, which
 *   is what stops a keyword-stuffed entry simply out-shouting a good one.
 * - **Longer entries won.** A long entry is likelier to contain three of five keywords than a tight
 *   one, purely by being long, so verbose entries outranked precise ones on nothing but size.
 *
 * **Why the F, and it is not decoration.** Plain BM25 treats a document as one bag of words, so
 * fixing the length problem introduces a worse one here: concatenating title, question, answer and
 * procedure into a single haystack means an entry carrying a real step list is LONGER, and length
 * normalisation then penalises it for exactly the content that makes it the best answer to a "how
 * do I" question. That is not hypothetical — it is what the existing procedure-retrieval test
 * caught the moment flat BM25 went in, which is precisely the regression that test was written to
 * prevent.
 *
 * BM25F keeps the structure the entry actually has. Each field is length-normalised against the
 * average length of THAT field, so a procedure is compared with other procedures rather than with
 * titles, and each carries a weight, so a term in the title counts for more than the same term
 * buried in a paragraph. An entry gains from having steps instead of being diluted by them.
 *
 * Pure and dependency-free. No vector store, no embedding call, no model: this is the strongest
 * ranking obtainable from the text alone, it is decades-proven, and it costs one pass over a few
 * hundred short documents. The existing decision not to reach for embeddings — a knowledge base
 * that holds hundreds of entries, not millions — is unchanged and still right.
 */

/**
 * Term-frequency saturation. 1.2 is the long-standing default from the TREC experiments BM25 came
 * out of, and this corpus gives no reason to depart from it: entries here are short and written to
 * answer one question, so repetition is mild and the curve barely matters above two or three
 * occurrences.
 */
const K1 = 1.2;

/** The searchable parts of a knowledge entry, each already normalized by the caller. */
export interface Bm25Fields {
  title: string;
  question: string;
  answer: string;
  procedure: string;
}

export type Bm25FieldName = keyof Bm25Fields;

interface FieldConfig {
  /** How much a match here counts, relative to the answer body at 1. */
  weight: number;
  /** How hard length is normalised away in this field, 0 (not at all) to 1 (fully). */
  b: number;
}

/**
 * What each field is worth, and how much its length should matter.
 *
 * These are the only judgement calls in the file, so each is stated rather than tuned into
 * existence:
 *
 * - **question (3.0)** is the strongest signal there is. It holds the question this entry was
 *   written to answer, phrased the way a customer would phrase it, so a match there is close to a
 *   direct hit. `b` is low because questions are uniformly short — normalising their length would
 *   mostly amplify noise.
 * - **title (2.5)** is the deliberate summary of what the entry is about. Slightly below the
 *   question only because titles are written for a list view rather than for matching.
 * - **procedure (2.0)** names the actual screens and actions in the actual order, which is the
 *   highest-fidelity material available for the "how do I do this" questions that dominate here.
 *   Weighted well above the answer body, and length-normalised like one, so a thorough eight-step
 *   procedure is judged against other procedures rather than against a one-line title.
 * - **answer (1.0)** is the baseline. It is prose, it is the longest field, and a term appearing
 *   somewhere in it is the weakest of these four signals — which is why full length normalisation
 *   (0.75, the standard default) belongs here most of all: a rambling answer should not outrank a
 *   precise one for having more room to mention the word.
 */
const FIELDS: Record<Bm25FieldName, FieldConfig> = {
  question: { weight: 3.0, b: 0.5 },
  title: { weight: 2.5, b: 0.5 },
  procedure: { weight: 2.0, b: 0.75 },
  answer: { weight: 1.0, b: 0.75 },
};

const FIELD_NAMES = Object.keys(FIELDS) as Bm25FieldName[];

export interface Bm25Document {
  id: string;
  fields: Bm25Fields;
}

export interface Bm25Score {
  id: string;
  /** Higher is more relevant. Comparable only within one call — see `rankByBm25`. */
  score: number;
  /**
   * How many DISTINCT query terms appear anywhere in this document.
   *
   * Kept beside the score on purpose. It is the OLD measure, and callers still need it: the
   * decision about whether a search was good enough to skip query expansion is expressed as "at
   * least two distinct keywords matched", a threshold that means nothing against a real-valued
   * score. Separating the two means this change reorders results without altering a single
   * downstream decision about whether to search again.
   */
  matchedTerms: number;
}

/**
 * Scores every document against the query terms, most relevant first.
 *
 * **IDF is computed over the documents passed in, not over the whole knowledge base**, and that is
 * the right choice rather than a shortcut. The job here is to tell these candidates apart from one
 * another; a term appearing in every one of them cannot do that, whatever its rarity across the
 * table, while a term in three of three hundred discriminates sharply. Measuring rarity over the
 * set being ranked answers exactly the question being asked — and it keeps this function pure, so
 * it stays unit-testable without a database, which is how the retrieval logic has been kept honest
 * so far.
 *
 * Scores are therefore comparable WITHIN one call and meaningless between two. Nothing here should
 * be compared against a score from a different candidate set or a different query.
 */
export function rankByBm25(documents: Bm25Document[], queryTerms: string[]): Bm25Score[] {
  if (documents.length === 0 || queryTerms.length === 0) return [];

  const terms = [...new Set(queryTerms.filter(Boolean))];
  const total = documents.length;

  // Per-field lengths, and each field's own average. A field that is empty across the whole
  // candidate set has an average of zero, which would make every ratio 0/0 — treating it as 1
  // makes the length factor vanish, which is the only sane reading of "this field does not exist
  // here".
  const lengths = documents.map((document) => {
    const perField = {} as Record<Bm25FieldName, number>;
    for (const field of FIELD_NAMES) perField[field] = tokenizeWords(document.fields[field]).length;
    return perField;
  });
  const averageLength = {} as Record<Bm25FieldName, number>;
  for (const field of FIELD_NAMES) {
    const sum = lengths.reduce((running, perField) => running + perField[field], 0);
    averageLength[field] = sum > 0 ? sum / total : 1;
  }

  // The BM25F pseudo-frequency: each field's raw count, divided by that field's own length factor
  // and multiplied by its weight, summed across fields. Saturation is applied AFTER this sum
  // rather than per field — that is what makes it BM25F rather than four separate BM25 scores
  // added together, and it matters: saturating per field would let a term repeated once in each of
  // four fields beat one repeated four times in the field that counts.
  const pseudoFrequencies = documents.map((document, index) => {
    const perTerm = new Map<string, number>();
    for (const term of terms) {
      let accumulated = 0;
      for (const field of FIELD_NAMES) {
        const count = countWholeWord(document.fields[field], term);
        if (count === 0) continue;
        const { weight, b } = FIELDS[field];
        const ratio = lengths[index]![field] / averageLength[field];
        accumulated += (weight * count) / (1 - b + b * ratio);
      }
      if (accumulated > 0) perTerm.set(term, accumulated);
    }
    return perTerm;
  });

  const idf = new Map<string, number>();
  for (const term of terms) {
    const df = pseudoFrequencies.filter((perTerm) => perTerm.has(term)).length;
    // The `1 +` inside the logarithm is load-bearing, not cosmetic. Robertson's original IDF goes
    // NEGATIVE once a term appears in more than half the corpus, which in a scorer that sums terms
    // means a common word actively subtracts from a document's score — so an entry could be pushed
    // below one that does not mention the customer's subject at all, purely for mentioning it too
    // popularly. This form is floored at zero: a term everything contains is worth nothing, which
    // is the intended meaning, and never worth less than nothing.
    idf.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
  }

  return documents
    .map((document, index) => {
      const perTerm = pseudoFrequencies[index]!;
      let score = 0;
      for (const [term, pseudoTf] of perTerm) {
        score += ((idf.get(term) ?? 0) * (pseudoTf * (K1 + 1))) / (K1 + pseudoTf);
      }
      return { id: document.id, score, matchedTerms: perTerm.size };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * How close two scores must be to count as equally relevant, as a fraction of the larger.
 *
 * This exists to keep a signal the previous ranker had and a continuous score would otherwise
 * destroy. "Came from this customer's own group" and "carries real steps" were TIEBREAKS, chosen
 * that way deliberately so they could never promote a less relevant entry over a more relevant
 * one. Exact ties are common when the score is an integer count and vanishingly rare when it is a
 * real number, so keeping them as exact-tie rules would have quietly deleted both.
 *
 * Two per cent preserves the original guarantee in the form that actually matters: a meaningfully
 * better entry still always wins, and the two signals decide only between entries the ranker
 * considers equally good.
 */
export const RELATIVE_TIE_EPSILON = 0.02;

/**
 * Groups an already-sorted score list into bands of "equally relevant".
 *
 * Returns a band index per document id: lower is better, and equal indices mean the ranker cannot
 * tell them apart, so a caller may order them by whatever else it knows.
 *
 * Banding rather than a fuzzy comparator, because "within two per cent" is NOT transitive — a can
 * tie b and b tie c while a beats c — and a non-transitive comparator handed to `Array.sort` gives
 * an implementation-defined order, which is the precise opposite of what a ranking that has to be
 * reproducible needs. Each band is measured from its own leader, so a long gentle slope of scores
 * cannot chain into one enormous band.
 */
export function bandByRelevance(scores: Bm25Score[]): Map<string, number> {
  const bands = new Map<string, number>();
  let band = 0;
  let leader: number | null = null;

  for (const entry of scores) {
    const startsNewBand = leader !== null && entry.score < leader * (1 - RELATIVE_TIE_EPSILON);
    if (startsNewBand) band += 1;
    if (leader === null || startsNewBand) leader = entry.score;
    bands.set(entry.id, band);
  }
  return bands;
}
