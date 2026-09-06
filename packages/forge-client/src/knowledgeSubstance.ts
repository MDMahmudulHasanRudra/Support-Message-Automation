/**
 * The substance gate: does an entry actually tell a customer anything?
 *
 * `knowledgeSafety.ts` next door answers "may this be said". This answers "is it worth saying".
 * They are separate because they fail in opposite directions — a disclosure violation must never
 * be stored at all, while a vague entry is merely useless and is kept for a person to improve.
 *
 * Why a vague entry is not harmless, which is the whole reason this exists:
 *
 * A generic answer still matches on ordinary words, so retrieval succeeds. Succeeding is exactly
 * the problem. `runAiFallback` only researches the product's source, and only hands over to a
 * person, when retrieval comes back **empty** — so one entry reading "refresh the page, check your
 * internet connection, contact your IT support" silently outranks both. The customer gets advice
 * that would fit any website ever written, the deep-answer path never runs, and nothing in the log
 * distinguishes it from a good answer. An empty knowledge base would have served that customer
 * better than a filler entry does.
 *
 * This is a triage aid, not an oracle. It is deliberately tuned to catch boilerplate rather than
 * to judge quality: a terse entry that names a real screen or a real number passes, because
 * brevity is not the defect — emptiness is.
 *
 * Pure functions over strings, so they can be unit tested exhaustively without a database, a
 * network, or a model.
 */

export interface SubstanceVerdict {
  substantive: boolean;
  /** Machine-readable rule ids that fired, for logs and the reviewer UI. */
  reasons: string[];
  /**
   * Advisory only, and deliberately not a reason: the answer names no screen, label, quantity or
   * product. Useful for sorting a review queue by "probably worth rewriting", never for withholding
   * verification on its own — see the note in `checkKnowledgeSubstance`.
   */
  bare: boolean;
}

/**
 * Boilerplate that could close any support answer on any product in the world. One of these is
 * ordinary — a good answer may reasonably end by pointing at a human. Two or more is the answer
 * being made of them.
 */
const GENERIC_MARKERS: RegExp[] = [
  /contact (?:your |the )?(?:it |customer )?support/i,
  /contact your (?:administrator|it team|provider)/i,
  /try again later/i,
  /if the (?:problem|issue) persists/i,
  /check your internet connection/i,
  /clear (?:your )?(?:the )?browser cache/i,
  /refresh(?:ing)? the page/i,
  /for (?:further|more) (?:assistance|help|information)/i,
  /(?:all )?required fields are filled/i,
  /make sure (?:that )?(?:all )?(?:the )?(?:information|details) (?:is|are) correct/i,
  /if none of these steps work/i,
];

/**
 * Counting markers was the first attempt and it was wrong. "If the problem persists, contact
 * support" is two matches and one idiomatic closing — a good answer that ends by pointing at a
 * person would have been flagged for being helpful about its own limits. Measuring the share of
 * the text they cover fails the other way: filler prose around the boilerplate dilutes the ratio,
 * and "check that all required fields are filled out correctly" scored as substantial.
 *
 * What actually separates the two is **where the concrete detail is**. A good answer names a
 * screen, a quantity or a product outside its closing line. A filler answer has nothing left once
 * the boilerplate is removed — "refresh the page" contributes the word "page" and no information.
 * So the anchor is looked for in what remains after the markers are stripped out.
 */

/**
 * Something a customer could actually look at or count. Any one of these is enough — the bar is
 * "names something real", not "names a button". A statement of product behaviour carrying a real
 * number ("12 monthly periods, activated by an administrator") is as concrete as a menu path.
 */
const UI_NOUNS =
  /\b(?:section|tab|menu|button|dropdown|drop-down|checkbox|field|form|column|report|page|screen|list|panel|dialog|toggle|filter|invoice|ticket|module|sidebar|wizard|export|import)\b/i;
/** A quoted label is the model naming something exactly, which is what we want it to do. */
const QUOTED_LABEL = /["“'']([^"“'']{2,40})["”'']/;
/** A digit is a quantity, a period, a limit, a version — all concrete. */
const NUMBER = /\d/;
/**
 * A capitalised word that is not starting a sentence is a proper noun: Mikrotik, bKash, Nagad,
 * Bandwidth Bill. `knowledgeSafety` has already refused the compound identifiers that would be
 * internal, so what survives here is a name a customer may legitimately be told.
 */
const MID_SENTENCE_PROPER_NOUN = /[a-z,]\s+(?:[A-Z][a-zA-Z]+|b[A-Z][a-z]+)/;

/** Below this an "answer" is a sentence fragment, not an answer — matched to the observed floor. */
const MIN_SUBSTANTIVE_ANSWER_CHARS = 120;

function countGenericMarkers(text: string): number {
  return GENERIC_MARKERS.filter((marker) => marker.test(text)).length;
}

/** What the answer still says once every piece of universal advice is taken out of it. */
function stripGenericMarkers(text: string): string {
  return GENERIC_MARKERS.reduce(
    (acc, marker) => acc.replace(new RegExp(marker.source, "gi"), " "),
    text,
  );
}

function hasConcreteAnchor(text: string): boolean {
  return (
    UI_NOUNS.test(text) || QUOTED_LABEL.test(text) || NUMBER.test(text) || MID_SENTENCE_PROPER_NOUN.test(text)
  );
}

/**
 * Judges one answer body. Exported separately from the entry-level check so a caller holding only
 * the answer text (a report over existing rows, say) does not have to fabricate a title.
 */
export function checkKnowledgeSubstance(answer: string): SubstanceVerdict {
  const text = answer.trim();
  const reasons: string[] = [];

  const bare = !hasConcreteAnchor(stripGenericMarkers(text));

  if (text.length < MIN_SUBSTANTIVE_ANSWER_CHARS) reasons.push("too-short");
  // Boilerplate is only a defect when nothing survives it. Run against the live knowledge base,
  // "names nothing concrete" on its own failed 88 of 318 entries, and reading them showed the
  // rule was wrong rather than the entries: "a bill can be cancelled, which creates a reversal
  // entry ... without deleting the original bill" states real product behaviour and happens to
  // name no button and contain no digit. A gate that sends answers like that back for review
  // buries the genuine filler in a queue nobody can face, so the anchor is now only evidence
  // against an answer that is *also* made of universal advice.
  if (bare && countGenericMarkers(text) > 0) reasons.push("generic-advice");

  return { substantive: reasons.length === 0, reasons, bare };
}

/** The entry-level check. The question adds no substance, so only the answer is judged. */
export function checkKnowledgeEntrySubstance(entry: { answer: string }): SubstanceVerdict {
  return checkKnowledgeSubstance(entry.answer);
}

/** Plain language for a reviewer, mirroring `describeViolation` next door. */
export function describeSubstanceReason(id: string): string {
  switch (id) {
    case "too-short":
      return "The answer is too short to carry a procedure or a fact.";
    case "generic-advice":
      return "The answer is mostly generic advice that would fit any product.";
    default:
      return "This entry did not meet the substance check.";
  }
}
