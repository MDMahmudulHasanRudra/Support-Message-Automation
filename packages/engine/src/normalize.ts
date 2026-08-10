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
