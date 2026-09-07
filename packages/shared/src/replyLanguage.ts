/**
 * The reply-language setting (`AiSettings.defaultReplyLanguage`), which is a free-text language
 * name passed to the model by name — plus the one value that is NOT a language name.
 *
 * Automatic detection cannot be expressed as a language, so it needs a sentinel. It lives here,
 * in the one package both apps import, for the same reason `AI_RESPONSE_MODES` does: the response
 * mode was silently saved as the wrong value for a week because the form and the server action
 * each carried their own hand-written copy of the valid list. A sentinel spelled out separately
 * in the settings form, the server action, the reply prompt and the style prompt would fail the
 * same way, and fail silently — the model would simply be told to answer in a language called
 * "__auto__".
 */

/**
 * Stored in `defaultReplyLanguage` to mean "match whatever the customer wrote".
 *
 * Deliberately not a plausible language name, and deliberately not empty: empty already means
 * "never configured" and falls back to the schema default, which is the opposite behaviour.
 */
export const AUTO_REPLY_LANGUAGE = "__auto__";

/** The language used when nothing is configured at all — also the schema default. */
export const FALLBACK_REPLY_LANGUAGE = "Bengali (Bangla)";

/**
 * What the assistant writes when a message carries no language signal at all — a bare greeting, a
 * number, an emoji — and there is no configured default to fall back on.
 *
 * Banglish rather than either pure language on purpose: it is the one form a Bengali speaker and
 * an English speaker can both read, so the least-wrong guess when there is genuinely nothing to
 * go on. The very next message the customer sends resolves it properly, since detection runs per
 * message rather than being latched.
 */
export const AUTO_TIEBREAK_LANGUAGE = "Banglish (Bengali words written in Latin letters)";

export function isAutoReplyLanguage(value: string | null | undefined): boolean {
  return value?.trim() === AUTO_REPLY_LANGUAGE;
}

/**
 * The setting rendered for a human or for a prompt that talks ABOUT the setting rather than
 * obeying it (the communication-style prompt says "the assistant writes in X").
 *
 * Without this, that prompt reads "The assistant writes in __auto__", which is not a sentence the
 * model can do anything sensible with.
 */
export function describeReplyLanguage(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return FALLBACK_REPLY_LANGUAGE;
  return isAutoReplyLanguage(trimmed) ? "whichever language the customer used" : trimmed;
}
