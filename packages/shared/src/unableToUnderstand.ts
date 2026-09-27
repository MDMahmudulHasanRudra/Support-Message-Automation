/**
 * The "AI could not understand" holding reply — what the customer is told when the AI hands their
 * message to a person because it had nothing reliable to say.
 *
 * Settings: `AiSettings.unableToUnderstandReplyEnabled` (off by default), the admin's wording in
 * `unableToUnderstandReplyText` (null = the built-in default below, so Reset is "forget my edit"
 * and a later improvement to the default reaches everyone who never changed it), and
 * `unableToUnderstandRepeatMinutes`, the quiet window per conversation.
 *
 * WHICH handovers count is the load-bearing decision, and it is made here as a list rather than
 * spread across the pipeline. A handover means one of two different things:
 *
 *   The AI had nothing reliable to say — it could not see into an image, nothing verified covered
 *   the question, it was not confident, it declined, or it drafted steps nobody documented. The
 *   customer is owed "we could not answer that, a person will follow up".
 *
 *   The SYSTEM stopped it — a cooldown or rate limit (the throttles that keep the WhatsApp number
 *   from being banned; sending another message there would defeat them), no AI provider, a
 *   provider error, a reply cut off by the token limit, a malformed response. Telling the customer
 *   "I did not understand you" there would be false, and for the throttles, harmful.
 *
 * Only the first kind is listed. Anything not listed — including any reason added later — does
 * NOT send, so a new handover path cannot start messaging customers by accident.
 */

export const DEFAULT_UNABLE_TO_UNDERSTAND_REPLY =
  "দুঃখিত ভাইয়া, আমি বিষয়টি বুঝতে পারিনি। একটু সময় দিন। আমাদের support team থেকে আপনার সাথে যোগাযোগ করা হবে। অনুগ্রহ করে একটু সময় অপেক্ষা করুন।";

export const UNABLE_TO_UNDERSTAND_MAX_LENGTH = 1000;

/** The outbound idempotency variant: one holding reply per customer message, ever. */
export const UNABLE_TO_UNDERSTAND_VARIANT = "unable-to-understand";

/** Bounds for the per-conversation quiet window, in minutes. */
export const UNABLE_TO_UNDERSTAND_REPEAT_MIN = 0;
export const UNABLE_TO_UNDERSTAND_REPEAT_MAX = 24 * 60;
export const UNABLE_TO_UNDERSTAND_REPEAT_DEFAULT = 30;

/** Handover reasons meaning "the AI had no reliable answer". Prefix-matched: NO_KNOWLEDGE carries a suffix. */
export const UNABLE_TO_UNDERSTAND_REASONS = [
  "MEDIA_ONLY_MESSAGE", // an image, voice note or sticker with no text — nothing here can see inside it
  "NO_KNOWLEDGE", // nothing verified covers it, and the response mode forbids general answers
  "NO_BUSINESS_KNOWLEDGE", // a question about this business with nothing verified behind it
  "AI_DECLINED", // the AI itself judged it could not answer
  "EMPTY_RESPONSE", // it said it would reply and produced nothing
  "LOW_CONFIDENCE", // below the confidence threshold (also covers LOW_CONFIDENCE_GENERAL)
  "INVENTED_PROCEDURE", // it drafted steps the knowledge base does not contain
] as const;

export function isUnableToUnderstandReason(reason: string): boolean {
  return UNABLE_TO_UNDERSTAND_REASONS.some((prefix) => reason === prefix || reason.startsWith(`${prefix}_`) || reason.startsWith(`${prefix}:`));
}

/** The wording to send: the admin's, or the default when none is saved (or it is blank). */
export function resolveUnableToUnderstandReply(stored: string | null | undefined): string {
  const text = stored?.trim();
  return text ? text : DEFAULT_UNABLE_TO_UNDERSTAND_REPLY;
}

/**
 * Checks wording typed on the settings page. Blank means "use the default" (stored as null), never
 * an empty message; the same text as the default is also stored as null so it keeps tracking it.
 */
export function validateUnableToUnderstandReply(
  input: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text || text === DEFAULT_UNABLE_TO_UNDERSTAND_REPLY) return { ok: true, value: null };
  if (text.length > UNABLE_TO_UNDERSTAND_MAX_LENGTH) {
    return { ok: false, error: `Keep the fallback message under ${UNABLE_TO_UNDERSTAND_MAX_LENGTH} characters (it is ${text.length}).` };
  }
  if (/\{\{[^}]*\}\}/.test(text)) {
    return { ok: false, error: "The fallback message is sent exactly as written — remove the {{…}} placeholder." };
  }
  return { ok: true, value: text };
}

/**
 * Words that carry no question: acknowledgements, greetings, thanks and the forms of address around
 * them, in English, Bangla and Banglish. Group chats are full of "ok vai", "thanks", "ধন্যবাদ" —
 * under the default strict mode each of those is a NO_KNOWLEDGE handover, and answering "sorry, I
 * did not understand" to somebody saying thank you is exactly the false trigger this must not have.
 */
const ACKNOWLEDGEMENT_WORDS = new Set(
  [
    // English
    "ok", "okay", "okk", "okey", "k", "kk", "yes", "yeah", "yep", "no", "nope", "sure", "fine", "done", "noted",
    "got", "it", "thanks", "thank", "you", "thx", "ty", "tnx", "welcome", "hi", "hello", "hey", "hmm", "hm",
    "good", "morning", "evening", "night", "great", "nice", "alright", "right", "cool", "bye", "please", "wait",
    "sir", "madam", "dear", "brother", "bro", "sis",
    // Banglish
    "vai", "bhai", "vaiya", "bhaiya", "apu", "apa", "acha", "accha", "achha", "thik", "ache", "ase", "ji", "jee",
    "jii", "hae", "ha", "haa", "hu", "dhonnobad", "donnobad", "salam", "assalamualaikum", "assalamu", "alaikum",
    "walaikum", "walaikumassalam", "oke",
    // Bangla
    "ঠিক", "আছে", "আচ্ছা", "ওকে", "জি", "জ্বি", "হ্যাঁ", "হা", "না", "ধন্যবাদ", "হ্যালো", "হাই", "ভাই", "ভাইয়া",
    "আপু", "স্যার", "সালাম", "আসসালামু", "আলাইকুম", "ওয়ালাইকুম", "শুভ", "সকাল", "সন্ধ্যা", "রাত", "অপেক্ষা", "করছি",
  ].map((word) => word.normalize("NFC")),
);

/**
 * True when a message is only an acknowledgement, greeting or thanks (or only emoji/punctuation),
 * so a holding reply saying "we did not understand" would be wrong. Conservative on purpose: one
 * word outside the list and it is treated as a real message.
 */
export function isAcknowledgementOnly(body: string): boolean {
  const words = body
    .normalize("NFC")
    .toLowerCase()
    // Letters and combining marks (Bangla vowel signs are marks, not letters) are kept; everything
    // else — punctuation, emoji, digits — separates words.
    .split(/[^\p{L}\p{M}]+/u)
    .filter(Boolean);
  return words.every((word) => ACKNOWLEDGEMENT_WORDS.has(word));
}

export function clampRepeatMinutes(value: number): number {
  if (!Number.isFinite(value)) return UNABLE_TO_UNDERSTAND_REPEAT_DEFAULT;
  return Math.min(UNABLE_TO_UNDERSTAND_REPEAT_MAX, Math.max(UNABLE_TO_UNDERSTAND_REPEAT_MIN, Math.round(value)));
}
