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
 * True if `needle` appears in `haystack` at a word boundary — not merely as
 * a substring. Plain `.includes()` would match the keyword "hi" inside
 * "this" or "or" inside "worker", which is wrong for short keyword tokens.
 * Works across scripts (Bangla letters count as word characters via \p{L}),
 * unlike JS's ASCII-only `\b`.
 */
export function containsWholeWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let fromIndex = 0;
  for (;;) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index === -1) return false;
    const before = index > 0 ? haystack[index - 1] : undefined;
    const after = index + needle.length < haystack.length ? haystack[index + needle.length] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) return true;
    fromIndex = index + 1;
  }
}
