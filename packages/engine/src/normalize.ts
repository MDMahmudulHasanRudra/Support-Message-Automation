// Zero-width space, ZWNJ, ZWJ, and the BOM/zero-width-no-break-space — these
// occasionally show up in WhatsApp messages (especially Bangla input methods)
// and would otherwise silently break exact/contains matching.
const ZERO_WIDTH_CODEPOINTS = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);

function stripZeroWidthChars(input: string): string {
  return Array.from(input)
    .filter((ch) => !ZERO_WIDTH_CODEPOINTS.has(ch.codePointAt(0) ?? -1))
    .join("");
}

/**
 * Normalizes message text for matching. Works uniformly across Bangla,
 * English, Banglish, and mixed-script messages: Bangla has no case concept
 * so `.toLowerCase()` only affects Latin runs, which is exactly what we want
 * for Banglish/English tokens like "Hello" vs "hello".
 */
export function normalizeText(text: string): string {
  return stripZeroWidthChars(text.normalize("NFC"))
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Every whole-word occurrence of `needle` in `haystack`, as start indices.
 *
 * The single scan `containsWholeWord` and `countWholeWord` both run on. They are the same question
 * asked twice — "is it there" and "how often" — and two hand-written copies of a word-boundary
 * rule is exactly the drift this codebase keeps getting bitten by. A caller that only needs the
 * first answer still pays for one scan, because `containsWholeWord` stops at the first hit.
 */
function* wholeWordMatches(haystack: string, needle: string): Generator<number> {
  if (!needle) return;
  let fromIndex = 0;
  for (;;) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index === -1) return;
    const before = index > 0 ? haystack[index - 1] : undefined;
    const after = index + needle.length < haystack.length ? haystack[index + needle.length] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) yield index;
    fromIndex = index + 1;
  }
}

/**
 * True if `needle` appears in `haystack` at a word boundary — not merely as
 * a substring. Plain `.includes()` would match the keyword "hi" inside
 * "this" or "or" inside "worker", which is wrong for short keyword tokens.
 * Works across scripts (Bangla letters count as word characters via \p{L}),
 * unlike JS's ASCII-only `\b`.
 */
export function containsWholeWord(haystack: string, needle: string): boolean {
  for (const _ of wholeWordMatches(haystack, needle)) return true;
  return false;
}

/**
 * How many times `needle` appears in `haystack` at a word boundary.
 *
 * The term-frequency half of BM25 ranking. Deliberately built on the SAME boundary rule as
 * `containsWholeWord` rather than on token equality: retrieval already decides what counts as a
 * match using that function, so counting by any other rule would mean the set of entries
 * considered relevant and the order they are ranked in disagreed about what "matches" means. In
 * particular it keeps matching a Bengali stem inside its inflected form, which is a recall
 * property worth keeping rather than an accident.
 */
export function countWholeWord(haystack: string, needle: string): number {
  let count = 0;
  for (const _ of wholeWordMatches(haystack, needle)) count += 1;
  return count;
}

/**
 * Splits already-normalized text into word tokens.
 *
 * `\p{M}` is in the keep-set, and for Bengali it is not optional. Bengali vowel signs — the কার
 * marks, ি া ে ো and the rest — are Unicode category Mark, not Letter. Without them here the
 * split treated every one as a separator, so ordinary words did not merely lose an accent, they
 * SHATTERED: "বিল" became "ব" + "ল" and "আমার" became "আম" + "র". Both fragments then fell under
 * the caller's minimum token length and were dropped, so the word disappeared entirely.
 *
 * The effect on this deployment, whose customers write Bengali: `derivePatternSignature("আমার বিল
 * কত")` returned ["আম","কত"] — the actual subject, বিল, gone. Every consumer inherited it, so
 * knowledge retrieval searched for fragments that match nothing, and Conversation Learning
 * clustered Bengali questions on debris. Latin text is unaffected: it carries no combining marks,
 * so the token set is identical to before for English and Banglish.
 *
 * Lives here rather than beside its first caller because it is now shared — pattern signatures,
 * search-term extraction and BM25's document-length measure all have to agree on what a word is,
 * and a second copy of this rule would re-introduce the bug above in one of them.
 */
export function tokenizeWords(normalizedText: string): string[] {
  return normalizedText.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
}
